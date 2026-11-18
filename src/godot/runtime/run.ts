// Godot CLI 运行器:spawn 一个受控 Godot 进程,严格分离捕获 stdout/stderr。
//
// 关键约束(architecture.test.ts 强制 + 任务硬性要求):
//   - 子进程 stdio 固定为 ["ignore","pipe","pipe"],绝不继承本进程 stdout ——
//     stdio 传输下 stdout 属于 MCP 协议,任何子进程输出进管道后由调用方放进结果 JSON。
//   - 不写任何控制台日志,也不直接写 stdout(architecture.test.ts 会扫)。
//   - 单文件即"纯参数构建 + 进程边界"两块:buildRunArgs/buildExportArgs 是纯函数可单测;
//     defaultRunRunner 是唯一真正 spawn 的地方,类型化后由 service 层注入替身。
//
// CLI 选项拼写已对照 tests/fixtures/godot-help.txt(真实 Godot 4.6.3 `--help` 输出)复验:
//   --path <directory> / --headless / --quit / --scene <path> / --export-release|--export-debug <preset> <path>。
import { decodeProcessOutput, type DecodedText } from "../../core/outputEncoding.js";
import { TaskCancelledError, TaskTimeoutError } from "../../core/concurrency/cancellation.js";
import { ProcessAdapter } from "./processAdapter.js";

/** 单个流的捕获上限,防止失控输出导致无界内存增长。 */
export const MAX_CAPTURE_BYTES = 256 * 1024;

export interface RunProcessOptions {
  /** 超过该毫秒数仍未退出则 SIGKILL。 */
  timeoutMs: number;
  /** 外部中止信号(例如 TaskQueue 的互斥取消)。已中止则立即杀进程。 */
  signal?: AbortSignal;
  /**
   * 子进程工作目录;缺省继承本进程 cwd。
   * 存在的原因:`--dump-extension-api` 把 extension_api.json 写到**进程 cwd**(4.6.3 `--help` 原文
   * «in the current folder»),调用方需要把产物定向到缓存目录。
   */
  cwd?: string;
}

export interface RunProcessResult {
  /** 退出码;被信号杀死时为 null。 */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** 到点杀进程(执行超时),与 aborted 互斥:两者都只有一个来源。 */
  timedOut: boolean;
  /**
   * 被外部信号中止(调用方取消)。T07 之前它与 timedOut 共用一个标志,
   * 导致取消被报成 TASK_TIMEOUT 且 retryable=true —— AI 会立刻重试,再起一个 Godot。
   */
  aborted?: boolean;
  /** 进程是否已确认退出(真实 runner 总是 true;只有"放弃等待"的兜底路径才会是 false)。 */
  exitConfirmed?: boolean;
  /** 子进程 PID(诊断用;spawn 失败时可能没有)。 */
  pid?: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** 实际解码采用的编码(真实 runner 填充;注入替身可省略)。 */
  stdoutEncoding?: DecodedText["encoding"];
  stderrEncoding?: DecodedText["encoding"];
  durationMs: number;
}

/** 注入缝:service 层测试用替身替换真实 spawn。 */
export type GodotRunRunner = (
  file: string,
  args: readonly string[],
  opts: RunProcessOptions,
) => Promise<RunProcessResult>;

const processAdapter = new ProcessAdapter();

/** 运行项目/场景的模式参数(纯数据,构建参数用)。 */
export interface RunMode {
  headless: boolean;
  quit: boolean;
  /** 要运行的场景(res:// 或项目相对路径);缺省用项目 main scene。经 --scene <path> 传入。 */
  scene?: string;
  /** 原样透传的额外 CLI 标志(无 shell,无注入)。 */
  extraArgs?: readonly string[];
}

/** 导出/构建的模式参数。 */
export interface ExportMode {
  preset: string;
  mode: "release" | "debug";
  /** 输出文件路径(必填,含二进制文件名,如 "builds/game.exe")。 */
  outputPath: string;
  headless: boolean;
  extraArgs?: readonly string[];
}

/**
 * godot 层会发出的全部 Godot CLI 标志(buildRunArgs / buildExportArgs / buildScreenshotArgs /
 * buildDumpExtensionApiArgs 的并集)。
 * 单一事实来源:新增/删除标志时同步此表;tests/runtime.real.test.ts 据此断言每个标志
 * 都出现在 tests/fixtures/godot-help.txt(由真实 `godot --help` 生成,见 T4.5)。
 */
export const RUNTIME_FLAGS: readonly string[] = [
  "--path",
  "--headless",
  "--quit",
  "--scene",
  "--script",
  "--check-only",
  "--export-release",
  "--export-debug",
  // ClassDB 快照导出(见 src/godot/api/extensionApi.ts;godot-help.txt:122)
  "--dump-extension-api",
];

/**
 * 构建"运行项目/场景"的完整参数列表。场景经 --scene <path> 指定(4.6.3 help 的显式写法)。
 */
export function buildRunArgs(projectDir: string, mode: RunMode): string[] {
  const args = ["--path", projectDir];
  if (mode.headless) args.push("--headless");
  if (mode.quit) args.push("--quit");
  if (mode.extraArgs) args.push(...mode.extraArgs);
  if (mode.scene) args.push("--scene", mode.scene);
  return args;
}

/**
 * 构建"导出/构建"的完整参数列表:--export-release|--export-debug <preset> <path>(path 必填,与 help 签名一致)。
 */
export function buildExportArgs(projectDir: string, mode: ExportMode): string[] {
  const args = ["--path", projectDir];
  if (mode.headless) args.push("--headless");
  if (mode.extraArgs) args.push(...mode.extraArgs);
  args.push(mode.mode === "debug" ? "--export-debug" : "--export-release", mode.preset, mode.outputPath);
  return args;
}

/** 发出 SIGKILL 之后等 close 的宽限。超时就升级重杀,并把"未确认退出"如实上报。 */
export const EXIT_CONFIRM_GRACE_MS = 3_000;
/** 升级重杀之后仍然等不到的硬上限:到这还没退出就放弃等待(锁由上层继续持有到此刻)。 */
export const EXIT_CONFIRM_HARD_CAP_MS = 120_000;

/**
 * 真实 spawn 实现:启动进程、分离收集两个流、到点杀进程、归一化退出信息。
 * 失败(如 ENOENT)通过 reject 抛出,由 service 层映射为 GODOT_NOT_FOUND。
 *
 * T07 的终止协议:
 *   1. 取消 / 超时都只发 SIGKILL(Windows 上即 TerminateProcess),然后**等 close**;
 *   2. 只有 close 到达才 settle(resolve 正常结束 / reject 取消)—— 调用方据此释放项目锁,
 *      不会出现"锁放了、进程还在写";取消走 reject,是为了让 pid、退出确认和输出这些
 *      证据随错误一起带出去,而不是藏在一个没人读的返回值字段里;
 *   3. 宽限内没等到 close:再杀一次,并 reject 一个带 `pendingExit` 的中断错误。
 *      TaskQueue 看到 pendingExit 会继续持有锁,直到进程真的退出(或到硬上限);
 *   4. 放弃等待时摘掉 stdout/stderr 监听并关闭管道,不泄漏 fd,也不继续吞输出。
 */
export function defaultRunRunner(
  file: string,
  args: readonly string[],
  opts: RunProcessOptions,
): Promise<RunProcessResult> {
  return createRunRunner(processAdapter)(file, args, opts);
}

/**
 * 用指定 adapter 构造 runner。存在的唯一理由是**可测**:退出无法确认的兜底路径
 * 只能用"永远不 close 的假子进程"触发,而模块级单例 adapter 无法注入。
 * 生产代码只使用上面的 defaultRunRunner,行为完全一致。
 */
export function createRunRunner(adapter: ProcessAdapter): GodotRunRunner {
  return (file, args, opts) => new Promise<RunProcessResult>((resolve, reject) => {
    const start = Date.now();
    let child;
    try { child = adapter.start(file, args, { cwd: opts.cwd }); }
    catch (e) {
      reject(e);
      return;
    }

    // 收集原始字节,退出后只解码一次:多字节字符不会被 chunk 边界拆坏。
    const stdout = { chunks: [] as Buffer[], bytes: 0, truncated: false };
    const stderr = { chunks: [] as Buffer[], bytes: 0, truncated: false };
    const unsubscribeStdout = child.onStdout((chunk) => collectBytes(chunk, stdout));
    const unsubscribeStderr = child.onStderr((chunk) => collectBytes(chunk, stderr));

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;
    let confirmTimer: NodeJS.Timeout | undefined;

    const detach = (): void => {
      if (timer) clearTimeout(timer);
      if (confirmTimer) clearTimeout(confirmTimer);
      timer = undefined;
      confirmTimer = undefined;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      unsubscribeStdout(); unsubscribeStderr(); unsubscribeError();
    };

    /**
     * 中断(取消/超时)统一入口:只有一个来源生效(先到先算),
     * 第二个来源不改变已定的性质 —— 否则取消会被后到的超时"洗"成 TASK_TIMEOUT。
     */
    const interrupt = (kind: "abort" | "timeout"): void => {
      // settled 之后到达的取消不改变已经确定的结果(进程都退了,再标 aborted 只会
      // 让上层把一个已完成的运行误判成取消)。
      if (settled || timedOut || aborted) return;
      if (kind === "abort") aborted = true; else timedOut = true;
      void child.stop("SIGKILL");
      confirmTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 升级:再发一次 SIGKILL(第一次可能发生在 spawn 完成前,pid 还没拿到)。
        void child.stop("SIGKILL");
        detach();
        const pid = child.pid;
        // pendingExit 在进程真正 close 或到达硬上限后 settle;它 settle 之前上层不得放锁。
        const pendingExit = Promise.race([
          child.exited.then(() => undefined),
          delay(EXIT_CONFIRM_HARD_CAP_MS).then(() => undefined),
        ]).then(() => { child.dispose(); }, () => { child.dispose(); });
        const details = {
          resolvedPath: file,
          pid,
          abortSource: kind,
          stage: "cleanup" as const,
          cleanup: {
            processExitConfirmed: false,
            ...(pid === undefined ? {} : { pid }),
            residual: [`process did not exit within ${EXIT_CONFIRM_GRACE_MS}ms of SIGKILL`],
          },
          hint: "The process may still be running. The project lock stays held until it exits, so no conflicting task starts.",
        };
        reject(kind === "abort"
          ? new TaskCancelledError(`Godot process (pid ${pid ?? "unknown"}) was cancelled but had not exited after ${EXIT_CONFIRM_GRACE_MS}ms`, details, pendingExit)
          : new TaskTimeoutError(`Godot process (pid ${pid ?? "unknown"}) was killed after ${opts.timeoutMs}ms but had not exited ${EXIT_CONFIRM_GRACE_MS}ms later`, { ...details, timeoutMs: opts.timeoutMs }, pendingExit));
      }, EXIT_CONFIRM_GRACE_MS);
      confirmTimer.unref?.();
    };
    const onAbort = (): void => interrupt("abort");

    if (opts.signal) {
      if (opts.signal.aborted) interrupt("abort");
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => interrupt("timeout"), opts.timeoutMs);

    const unsubscribeError = child.onError((e) => {
      if (settled) return;
      settled = true;
      detach();
      reject(e);
    });
    void child.exited.then(({ exitCode, signal }) => {
      if (settled) return;
      settled = true;
      detach();
      const out = decodeProcessOutput(Buffer.concat(stdout.chunks), { truncated: stdout.truncated });
      const err = decodeProcessOutput(Buffer.concat(stderr.chunks), { truncated: stderr.truncated });
      const logs = {
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutEncoding: out.encoding,
        stderrEncoding: err.encoding,
        durationMs: Date.now() - start,
        exitCode,
        signal,
      };
      // 取消后进程确实停下来了:用 reject 而不是"resolve 一个 aborted 结果"上报。
      // 原因:resolve 的返回值会被上层当成正常结束,pid / 退出确认 / 输出这些证据
      // 只有在错误里才会被完整带出去(TaskQueue 会原样保留 TaskCancelledError)。
      // 走到这里说明 close 已到达 → exitConfirmed 为 true,项目锁可以立刻归还。
      if (aborted) {
        const pid = child.pid;
        reject(new TaskCancelledError(`Godot process (pid ${pid ?? "unknown"}) was cancelled and has exited`, {
          resolvedPath: file,
          pid,
          abortSource: "request",
          stage: "cleanup",
          cleanup: { processExitConfirmed: true, ...(pid === undefined ? {} : { pid }) },
          ...logs,
        }));
        return;
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        aborted,
        exitConfirmed: true,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        stdout: logs.stdout,
        stderr: logs.stderr,
        stdoutTruncated: logs.stdoutTruncated,
        stderrTruncated: logs.stderrTruncated,
        stdoutEncoding: logs.stdoutEncoding,
        stderrEncoding: logs.stderrEncoding,
        durationMs: logs.durationMs,
      });
    });
  });
}

/** 简单的毫秒等待(硬上限用);unref 掉,不阻止进程退出。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** 始终消费 data 事件以排空管道(防止子进程因 stdout 缓冲满而阻塞);超过上限后只排不存。 */
function collectBytes(chunk: Buffer, out: { chunks: Buffer[]; bytes: number; truncated: boolean }): void {
  if (out.truncated) return;
  const room = MAX_CAPTURE_BYTES - out.bytes;
  if (room <= 0) { out.truncated = true; return; }
  const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
  out.chunks.push(slice);
  out.bytes += slice.length;
  if (slice.length < chunk.length) out.truncated = true;
}

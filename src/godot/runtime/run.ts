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
  timedOut: boolean;
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

/**
 * 真实 spawn 实现:启动进程、分离收集两个流、到点杀进程、归一化退出信息。
 * 失败(如 ENOENT)通过 reject 抛出,由 service 层映射为 GODOT_NOT_FOUND。
 */
export function defaultRunRunner(
  file: string,
  args: readonly string[],
  opts: RunProcessOptions,
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let child;
    try { child = processAdapter.start(file, args, { cwd: opts.cwd }); }
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
    let timer: NodeJS.Timeout | undefined;

    const kill = (): void => {
      timedOut = true;
      void child.stop("SIGKILL");
    };

    if (opts.signal) {
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", kill, { once: true });
    }
    timer = setTimeout(kill, opts.timeoutMs);

    const unsubscribeError = child.onError((e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", kill);
      unsubscribeStdout(); unsubscribeStderr(); unsubscribeError();
      reject(e);
    });
    void child.exited.then(({ exitCode, signal }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", kill);
      const out = decodeProcessOutput(Buffer.concat(stdout.chunks), { truncated: stdout.truncated });
      const err = decodeProcessOutput(Buffer.concat(stderr.chunks), { truncated: stderr.truncated });
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutEncoding: out.encoding,
        stderrEncoding: err.encoding,
        durationMs: Date.now() - start,
      });
    });
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

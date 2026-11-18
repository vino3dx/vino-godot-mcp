import { GodotMcpError } from "../errors.js";
import {
  cancelledError,
  pendingExitOf,
  TaskCancelledError,
  TaskTimeoutError,
  type AbortSource,
} from "./cancellation.js";
import { LockManager, normalizeLockKey, newTaskId, type LockOwnerInput, type LockWaitInfo } from "./lockManager.js";

export interface RunOptions {
  waitTimeoutMs?: number; // 排队等待上限
  runTimeoutMs?: number;  // 执行上限;超时会 abort signal,并在底层真正停下后才释放队列位置
  onWait?: (info: LockWaitInfo) => void;
  /**
   * 请求级取消信号(T07)。abort 后:任务级 controller 立即 abort;
   * 排队中则退出队列(拿到锁也立刻归还);已开始的工作则等它真正停下再释放锁。
   */
  signal?: AbortSignal;
  /**
   * 取消/超时之后,等底层自行停下的宽限。超过它就向上报"清理未完成"并**继续持有锁**,
   * 而不是无限等待、也不是假装已经停干净。默认 CANCEL_GRACE_MS。
   */
  cancelGraceMs?: number;
}

/** 取消后等底层停下的默认宽限:足够 SIGKILL + close 往返,又不至于让调用方干等。 */
export const CANCEL_GRACE_MS = 30_000;

/**
 * 项目级 Godot 运行队列:同一项目同一时间只允许一个 Godot 进程。
 * 底层复用 LockManager(key 前缀 godot-run:),不重复造轮子。
 *
 * fn 必须响应 signal(例如超时时杀掉 Godot 子进程)。T07 补充的约定:
 *   - fn 只在底层进程**确认退出**后才正常返回或抛出普通错误;
 *   - 没确认退出时必须抛出带 `pendingExit` 的错误,本类看到它就不释放项目锁,
 *     等它 settle 再放 —— 宁可让同项目的下一个任务多等,也不让它在旧进程还可能写文件时并发启动。
 */
export class TaskQueue {
  constructor(private readonly locks: LockManager) {}

  async runExclusive<T>(
    projectPath: string, input: LockOwnerInput, fn: (signal: AbortSignal) => Promise<T>, opts: RunOptions = {},
  ): Promise<T> {
    const key = `godot-run:${normalizeLockKey(projectPath)}`;
    const operation = input.tool;
    const signal = opts.signal;

    // 1) 进队列之前就被取消:连锁都不碰。
    if (signal?.aborted) throw cancelledError({ operation, stage: "queue", signal, hint: "Request was already cancelled." });

    const acquireOpts = {
      ...(opts.waitTimeoutMs !== undefined ? { timeoutMs: opts.waitTimeoutMs } : {}),
      ...(opts.onWait ? { onWait: opts.onWait } : {}),
      ...(signal ? { signal } : {}),
    };
    const release = await this.locks.acquire(key, { ...input, taskId: input.taskId ?? newTaskId() }, acquireOpts);

    // 2) 抢到锁的瞬间被取消:立刻归还,不能让项目锁挂在已取消的任务名下。
    if (signal?.aborted) {
      release();
      throw cancelledError({ operation, stage: "queue", signal });
    }

    const ctrl = new AbortController();
    const graceMs = opts.cancelGraceMs ?? CANCEL_GRACE_MS;
    let abortSource: AbortSource | undefined;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let guardReject: ((e: unknown) => void) | undefined;
    let work: Promise<T> | undefined;

    const onRequestAbort = (): void => {
      // 只有第一个来源生效:超时之后再来的取消,不改变本次任务的性质。
      abortSource ??= "request";
      ctrl.abort(signal?.reason);
    };

    const guard = new Promise<never>((_, reject) => {
      guardReject = reject;
    });

    /** 底层迟迟不响应 abort 时的兜底:报"清理未完成",锁延迟到 work settle 再放。 */
    const armGrace = (): void => {
      if (graceTimer || abortSource === undefined) return;
      graceTimer = setTimeout(() => {
        const source = abortSource ?? "request";
        const settled = work === undefined ? Promise.resolve() : work.then(() => undefined, () => undefined);
        const cleanup = { processExitConfirmed: false, residual: ["underlying operation did not stop within the grace period"] };
        guardReject?.(source === "request"
          ? cancelledError({
              operation, stage: "cleanup", signal, cleanup, pendingExit: settled,
              hint: `The caller cancelled, but the underlying operation had not stopped after ${graceMs}ms; the project lock stays held until it does.`,
            })
          : new TaskTimeoutError(
              `Task ${operation} exceeded its run timeout, but the underlying operation had not stopped after ${graceMs}ms`,
              { key, graceMs, cleanup, hint: "The project lock stays held until the underlying operation actually stops." },
              settled,
            ));
      }, graceMs);
      graceTimer.unref?.(); // 兜底定时器不该把进程钉在事件循环里
    };

    let result: T | undefined;
    let failure: unknown;
    let succeeded = false;

    signal?.addEventListener("abort", onRequestAbort, { once: true });
    signal?.addEventListener("abort", armGrace, { once: true });

    try {
      work = fn(ctrl.signal);
      if (opts.runTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          abortSource ??= "timeout";
          ctrl.abort(new GodotMcpError("TASK_TIMEOUT", `Task ${operation} exceeded ${opts.runTimeoutMs}ms`, { key, runTimeoutMs: opts.runTimeoutMs }));
          armGrace();
        }, opts.runTimeoutMs);
      }
      if (signal?.aborted) armGrace();

      const value = await Promise.race([work, guard]);
      if (abortSource === "request") {
        // 3) 取消与正常完成赛跑:只要已经 abort,就不允许报成功。
        failure = cancelledError({ operation, stage: "running", signal, cleanup: { processExitConfirmed: true } });
      } else if (abortSource === "timeout") {
        failure = timeoutError(operation, key, opts.runTimeoutMs);
      } else {
        result = value;
        succeeded = true;
      }
    } catch (e) {
      failure = mapInterrupt(e, operation, key, abortSource, signal, opts.runTimeoutMs);
    } finally {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onRequestAbort);
      signal?.removeEventListener("abort", armGrace);
      const pending = pendingExitOf(failure);
      if (pending) {
        // 底层还没停:锁必须留着,等它真的停下来再放(releaser 自身幂等,不会重复释放)。
        void pending.then(release, release);
      } else {
        release();
      }
    }

    if (!succeeded) throw failure;
    return result as T;
  }
}

/** 把"因 abort 而失败"的错误归一成 TASK_CANCELLED / TASK_TIMEOUT;无关错误原样透传。 */
function mapInterrupt(
  e: unknown,
  operation: string,
  key: string,
  abortSource: AbortSource | undefined,
  signal: AbortSignal | undefined,
  runTimeoutMs: number | undefined,
): unknown {
  if (abortSource === undefined) return e;
  if (abortSource === "request") {
    // 底层已经给出更精确的取消诊断(含 pendingExit / cleanup),原样保留。
    if (e instanceof TaskCancelledError) return e;
    return cancelledError({ operation, stage: "running", signal, cause: e, cleanup: { processExitConfirmed: true } });
  }
  // 超时:保留 TASK_TIMEOUT 原语义,不因为内部 abort 而变成取消。
  if (e instanceof TaskTimeoutError) return e;
  return timeoutError(operation, key, runTimeoutMs, e);
}

function timeoutError(operation: string, key: string, runTimeoutMs: number | undefined, cause?: unknown): GodotMcpError {
  return new GodotMcpError("TASK_TIMEOUT", `Task ${operation} exceeded ${runTimeoutMs}ms and was aborted`, {
    key,
    ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
    ...(cause === undefined ? {} : { cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) }),
  });
}

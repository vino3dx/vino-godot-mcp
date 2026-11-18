// T07:取消语义的唯一出处。
//
// 这层只做三件事,不碰进程、不碰队列:
//   1. TASK_CANCELLED 错误的统一构造(带 stage / abortSource / cleanup 诊断);
//   2. `pendingExit` —— "底层资源还没确认停止"的信号。TaskQueue 看到它就不释放项目锁,
//      等它 settle 再释放。这是"取消成功但进程还在写文件"的唯一防线。
//   3. `throwIfAborted` 检查点,供可中断循环使用。
//
// 为什么 pendingExit 放在 Error 实例上而不是 details 里:details 会原样进 MCP 响应
// (JSON.stringify 一个 Promise 会变成 {}),而 pendingExit 只在进程内传递,不能上线。
import { GodotMcpError, type ErrorDiagnostics } from "../errors.js";
import type { ErrorCode } from "../../types/index.js";

/** 取消发生在哪个阶段:排队中 / 执行中(含子进程) / 清理中。 */
export type CancelStage = "queue" | "running" | "cleanup";

/** 取消来源:调用方请求取消,还是我们自己的执行超时。 */
export type AbortSource = "request" | "timeout";

export interface CleanupReport {
  /** 底层进程是否已确认退出。false = 仍在运行或状态未知,调用方必须保持项目锁。 */
  processExitConfirmed: boolean;
  /** 相关子进程 PID(便于运维人工确认残留)。 */
  pid?: number;
  /** 残留物(临时文件、半成品产物)说明。 */
  residual?: string[];
  /** 清理本身失败的原因(不覆盖原始取消原因,只做补充)。 */
  error?: string;
}

/**
 * 带"清理未完成"信息的错误基类。
 *
 * `pendingExit` 在资源真正停止(或到达硬上限)后 settle;TaskQueue 据此决定是否延迟释放锁。
 * 没有它时(绝大多数路径:进程已确认退出)可以同步释放。
 */
export abstract class InterruptAwareError extends GodotMcpError {
  /** 资源尚未确认停止时提供;settle 后可安全释放项目锁。 */
  readonly pendingExit: Promise<void> | undefined;

  protected constructor(
    code: ErrorCode,
    message: string,
    details: (Record<string, unknown> & ErrorDiagnostics) | undefined,
    pendingExit: Promise<void> | undefined,
  ) {
    super(code, message, details);
    this.pendingExit = pendingExit;
  }
}

/** 调用方主动取消。category=cancelled,retryable=false。 */
export class TaskCancelledError extends InterruptAwareError {
  constructor(
    message: string,
    details?: Record<string, unknown> & ErrorDiagnostics,
    pendingExit?: Promise<void>,
  ) {
    super("TASK_CANCELLED", message, details, pendingExit);
    this.name = "TaskCancelledError";
  }
}

/**
 * 执行超时,但底层进程未确认退出。
 * 只在"超时后进程仍未 close"的极少数场景使用;错误码与语义仍是 TASK_TIMEOUT,
 * 只是额外携带 pendingExit 让锁继续被持有 —— 不把超时伪装成取消。
 */
export class TaskTimeoutError extends InterruptAwareError {
  constructor(
    message: string,
    details?: Record<string, unknown> & ErrorDiagnostics,
    pendingExit?: Promise<void>,
  ) {
    super("TASK_TIMEOUT", message, details, pendingExit);
    this.name = "TaskTimeoutError";
  }
}

/** TaskQueue 用:任何带 pendingExit 的抛出都意味着"锁先别放"。 */
export function pendingExitOf(e: unknown): Promise<void> | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const pending = (e as { pendingExit?: unknown }).pendingExit;
  return pending instanceof Promise ? pending : undefined;
}

export interface CancelledOptions {
  operation: string;
  stage: CancelStage;
  /** 默认 request;timeout 只用于内部统一判定,对外的 code 仍是各自的码。 */
  abortSource?: AbortSource;
  signal?: AbortSignal;
  cause?: unknown;
  cleanup?: CleanupReport;
  hint?: string;
  /** 资源尚未确认停止时传入:错误本身携带它,TaskQueue 据此延迟释放锁。 */
  pendingExit?: Promise<void>;
}

/** 构造 TASK_CANCELLED:message 说清"谁取消了什么",details 说清"停在哪、清没清干净"。 */
export function cancelledError(o: CancelledOptions): TaskCancelledError {
  const source = o.abortSource ?? "request";
  const reason = abortReasonText(o.signal);
  const details: Record<string, unknown> & ErrorDiagnostics = {
    operation: o.operation,
    stage: o.stage,
    abortSource: source,
  };
  if (reason !== undefined) details["signalReason"] = reason;
  if (o.cleanup) details["cleanup"] = o.cleanup;
  if (o.hint !== undefined) details["hint"] = o.hint;
  if (o.cause !== undefined) details["cause"] = describeCause(o.cause);
  return new TaskCancelledError(`Task ${o.operation} was cancelled by the caller`, details, o.pendingExit);
}

/**
 * signal.reason → 一行文本。
 * 客户端(SDK)把 abort reason 原样带过来,可能是 Error、字符串或任意值;
 * 这里只保留可读的一段,避免把巨大对象塞进 MCP 响应。
 */
export function abortReasonText(signal: AbortSignal | undefined): string | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (reason === undefined) return undefined;
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 可中断循环检查点。already-aborted 时立刻抛 TASK_CANCELLED(带 stage)。 */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string, stage: CancelStage = "running"): void {
  if (signal?.aborted) throw cancelledError({ operation, stage, signal });
}

/** 已经是取消/中断错误就原样透传,避免被外层包成 GODOT_PROCESS_FAILED 之类。 */
export function isCancellation(e: unknown): e is TaskCancelledError {
  return e instanceof TaskCancelledError || (e instanceof GodotMcpError && e.code === "TASK_CANCELLED");
}

/** 非 Error 的 cause 也要在 details 里留下痕迹(只留可读部分)。 */
function describeCause(cause: unknown): string {
  if (cause instanceof GodotMcpError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  const text = String(cause);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * 给已经抛出的错误补一份清理诊断。
 *
 * 为什么不新建错误对象:新建会丢掉 `TaskCancelledError` 的具体类型,连带丢掉 pendingExit
 * (锁延迟释放的依据)。所以这里只往 details 上合并,code / message / 原始原因都不动 ——
 * "清理失败不覆盖原始取消原因"。`residual` 单独按累积规则合并(见 mergeResidual):
 * 后到的空数组不能抹掉先前的残留记录。
 */
export function attachCleanup(e: unknown, cleanup: CleanupReport): void {
  if (!(e instanceof GodotMcpError)) return;
  const details = e.details ?? {};
  const existing = details["cleanup"];
  const prev = typeof existing === "object" && existing !== null ? (existing as CleanupReport) : undefined;
  const merged: CleanupReport = prev ? { ...prev, ...cleanup } : cleanup;
  // residual 是累积诊断,不是"最后一次说了算":后到的空数组(例如导出 staging 清干净了)
  // 不能抹掉先前记录的残留(例如"进程未确认退出、可能还在写")。非空则取并集去重。
  const residual = mergeResidual(prev?.residual, cleanup.residual);
  if (residual !== undefined) merged.residual = residual;
  e.details = { ...details, cleanup: merged };
}

/** 残留合并规则:旧的非空记录永远保留;新的非空值追加去重;两边都空才得到空数组。 */
function mergeResidual(prev: string[] | undefined, next: string[] | undefined): string[] | undefined {
  const before = prev ?? [];
  if (next === undefined) return prev === undefined ? undefined : [...before];
  if (next.length === 0) return [...before];
  return [...new Set([...before, ...next])];
}

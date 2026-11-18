import type { ErrorCategory, ErrorCode } from "../types/index.js";

/**
 * 错误分类:给 AI 一个比 code 更粗的维度,用来决定"下一步该干什么"
 * (改参数 / 改配置 / 等一会重试 / 换环境 / 报 bug)。类型定义在最底层的 types,这里只做映射。
 */
const CATEGORY: Record<ErrorCode, ErrorCategory> = {
  INVALID_ARGUMENT: "input",
  TOOL_NOT_FOUND: "not-found",
  FILE_NOT_FOUND: "not-found",
  PARSE_ERROR: "input",
  LOCK_TIMEOUT: "concurrency",
  TASK_TIMEOUT: "concurrency",
  RUNTIME_REQUIRED: "engine",
  RUNTIME_FAILED: "engine",
  INTERNAL: "internal",
  PROJECT_NOT_FOUND: "not-found",
  RESOURCE_NOT_FOUND: "not-found",
  GODOT_NOT_FOUND: "engine",
  GODOT_PROCESS_FAILED: "engine",
  VALIDATION_FAILED: "input",
  FILE_CHANGED: "filesystem",
  PROTECTED_PATH: "filesystem",
  ALREADY_EXISTS: "filesystem",
  BRIDGE_UNAVAILABLE: "editor",
  BRIDGE_DISCONNECTED: "editor",
  BRIDGE_TIMEOUT: "editor",
  BRIDGE_PROTOCOL_ERROR: "editor",
  EDITOR_INSTANCE_MISMATCH: "editor",
  EDITOR_NO_SCENE_OPEN: "editor",
  EDITOR_SCENE_ROOT_MISSING: "editor",
  EDITOR_NODE_NOT_FOUND: "editor",
  EDITOR_OBJECT_INVALID: "editor",
  EDITOR_RESPONSE_TOO_LARGE: "editor",
  EDITOR_PROPERTY_UNKNOWN: "editor",
  EDITOR_PROPERTY_INVALID: "editor",
  EDITOR_NODE_EXISTS: "editor",
  EDITOR_NODE_TYPE_UNKNOWN: "editor",
  EDITOR_CANNOT_REMOVE_ROOT: "editor",
  EDITOR_HISTORY_EMPTY: "editor",
  EDITOR_WRITE_UNAVAILABLE: "editor",
  EDITOR_SELECTION_UNAVAILABLE: "editor",
  INVALID_CONFIGURATION: "configuration",
  TOOL_SELECTION_EMPTY: "configuration",
  READ_ONLY: "permission",
  CONFIRMATION_REQUIRED: "permission",
};

/** 重试语义:只有"等一会可能就好了"的错误才算可重试。 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "LOCK_TIMEOUT",
  "TASK_TIMEOUT",
  "BRIDGE_TIMEOUT",
  "BRIDGE_DISCONNECTED",
  "BRIDGE_UNAVAILABLE",
]);

export const errorCategory = (code: ErrorCode): ErrorCategory => CATEGORY[code] ?? "internal";
export const errorRetryable = (code: ErrorCode): boolean => RETRYABLE.has(code);

/**
 * 结构化诊断字段。全部可选 —— 不是每条错误都知道全部信息,但知道的部分必须准确。
 * 这些 key 直接进 error.details,不改变既有 details 契约(老调用方仍可 details.path 取值)。
 */
export interface ErrorDiagnostics {
  /** 出问题的路径。三种路径要分清:文件路径 / 脚本路径 / 场景节点路径。 */
  path?: string;
  file?: string;
  nodePath?: string;
  line?: number;
  column?: number;
  /** 正在做的操作,例如 "scene.removeNode" / "bridge.setProperty"。 */
  operation?: string;
  /** 期望值 / 实际值(类型错误时是类型名)。 */
  expected?: unknown;
  actual?: unknown;
  /** 给 AI 的一句话修复建议。 */
  hint?: string;
  /** 额外的结构化上下文(锁持有者、引擎 stderr 摘要等)。 */
  context?: Record<string, unknown>;
}

/** 所有可预期错误都抛 GodotMcpError,带稳定错误码。 */
export class GodotMcpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  /** 由 code 推导,不单独维护,避免两处不一致。 */
  readonly category: ErrorCategory;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown> & ErrorDiagnostics) {
    super(message);
    this.name = "GodotMcpError";
    this.code = code;
    this.details = details;
    this.category = errorCategory(code);
    this.retryable = errorRetryable(code);
  }
}

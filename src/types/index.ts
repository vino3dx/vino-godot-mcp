// 全局共享类型。此文件不得 import 任何其他 src 模块(最底层,零依赖)。

/** 稳定错误码。只追加,不改名。 */
export type ErrorCode =
  | "INVALID_ARGUMENT" | "TOOL_NOT_FOUND" | "FILE_NOT_FOUND" | "PARSE_ERROR"
  | "LOCK_TIMEOUT" | "TASK_TIMEOUT" | "RUNTIME_REQUIRED" | "RUNTIME_FAILED" | "INTERNAL"
  | "PROJECT_NOT_FOUND" | "RESOURCE_NOT_FOUND" | "GODOT_NOT_FOUND" | "GODOT_PROCESS_FAILED"
  | "VALIDATION_FAILED" | "FILE_CHANGED" | "PROTECTED_PATH"
  // Editor Bridge 通道(editor 上下文):传输层失败与 Editor 侧语义失败分开报,不再统一成"连接关闭"。
  | "BRIDGE_UNAVAILABLE" | "BRIDGE_DISCONNECTED" | "BRIDGE_TIMEOUT" | "BRIDGE_PROTOCOL_ERROR"
  | "EDITOR_INSTANCE_MISMATCH"
  | "EDITOR_NO_SCENE_OPEN" | "EDITOR_SCENE_ROOT_MISSING" | "EDITOR_NODE_NOT_FOUND"
  | "EDITOR_OBJECT_INVALID" | "EDITOR_RESPONSE_TOO_LARGE";

/** 最小 JSON Schema 子集(工具入参),校验器只支持这些字段,见 core/validation。 */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean; // object 默认 false(拒绝未知参数)
  enum?: ReadonlyArray<string | number>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  default?: unknown;
}

/** 工具领域,与 src/tools/<domain> 目录一一对应。 */
export type ToolDomain =
  | "project" | "scene" | "node" | "class" | "resource" | "script" | "shader" | "material"
  | "animation" | "filesystem" | "asset" | "debug" | "runtime" | "utility"
  | "editor" // 运行中的 Godot Editor 实时状态(与 scene 的磁盘 .tscn、runtime 的运行场景区分)
  | "ui" | "tilemap" | "particles" | "navigation" | "audio"; // 后五个属于第二版领域

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/**
 * 内联图片内容块(base64 + mimeType)。由 mcp 层转成 MCP image 内容块
 * ({ type: "image", data, mimeType }),不随 text 块序列化。
 */
export interface ImageContent { data: string; mimeType: string }

/**
 * 工具处理函数的返回(成功时)。失败一律 throw GodotMcpError。
 * warnings:非致命提示(例如 EDITOR_CONFLICT_WARNING),走这里而不是错误。
 * image:可选的图片内容块(例如截图工具),由 mcp 层作为第二个 content block 输出。
 */
export interface ToolOutput { data: unknown; message?: string; warnings?: string[]; image?: ImageContent }

/** 统一的工具执行结果(ToolHost 产出)。 */
export type ToolResult =
  | { ok: true; data: unknown; message?: string; warnings?: string[]; image?: ImageContent }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };

export interface ToolAnnotations { readOnly: boolean; destructive?: boolean; idempotent?: boolean }

/**
 * 工具的外部依赖:调用时真正需要存在的外部能力。与 ToolDomain 正交——
 * domain 说的是"这个工具属于哪个功能领域",dependency 说的是"调用它需要什么环境"。
 *
 * - `none`:只需 Node 进程 + 本地文件系统(含 Godot 文本资源的静态解析/写入)。
 * - `godot`:需要 Godot 可执行文件或引擎能力(CLI 探测、headless 运行、ClassDB dump、引擎校验),
 *   包括依赖"由 Godot 创建的会话"的工具。
 * - `bridge`:需要正在运行且可连接的 Godot Editor Bridge(EditorPlugin 的 TCP 通道)。
 *
 * 必须逐个工具显式声明,不得由 name 前缀、domain 或 runtimeRequired 推断。
 */
export type ToolDependency = "none" | "godot" | "bridge";

/**
 * 工具定义。Ctx 由组合根(src/index.ts)决定,mcp 层不知道它的具体类型。
 * 命名规则:`<domain>_<action>`,name 必须以 domain 开头(注册时强制)。
 */
export interface ToolDefinition<Ctx = unknown> {
  name: string;
  domain: ToolDomain;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: ToolAnnotations;
  /**
   * 调用该工具所必需的外部能力(见 ToolDependency)。与 domain、runtimeRequired 都是独立维度。
   */
  dependency: ToolDependency;
  /**
   * 历史遗留的"运行状态提示":handler 是否会通过 Runtime Adapter 启动/停止一个 Godot 进程。
   * 它**不是**"调用需要 Godot":一次性 CLI 探测(runtime_get_version)、引擎探针可降级为静态扫描
   * (runtime_check_addon_status)、依赖已有 Godot 会话(runtime_get_session)都声明 false。
   * 因此不能用它推断 dependency,也不能用 dependency 反推它;当前没有执行门槛,只用于展示。
   */
  runtimeRequired: boolean;
  handler(args: Record<string, unknown>, ctx: Ctx): Promise<ToolOutput>;
}

// Editor Bridge 通道(editor 上下文)。
//
// 数据来源只有一个:运行中的 Godot Editor 里的 EditorPlugin,它用 EditorInterface 读
// 当前编辑场景。这里不做任何 .tscn 文本解析,也不假装是运行中的 SceneTree。
// 传输层错误(descriptor 缺失/连接关闭/超时)与 Editor 侧语义错误(没打开场景/节点不存在)
// 分别映射成不同错误码,不再统一成 "Bridge connection closed"。
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import type { ErrorCode } from "../types/index.js";
import { NativeBridgeClient, NativeBridgeError, readBridgeDescriptor, type BridgeDescriptor } from "../godot/bridge/client.js";
import { BRIDGE_PROTOCOL_VERSION } from "../godot/bridge/protocol.js";

export interface ProjectCapabilities { protocolVersion: number; godotVersion: string; godotInstanceId: string; bridgeSessionId: string; projectPath: string; projectId: string; editorConnected: boolean; pluginRunning: boolean; currentScene?: { path: string; rootName?: string; rootClass?: string; objectId?: string | null; isDirty?: boolean | null; isDirtyReason?: string }; nativeCapabilities: Record<string, boolean>; [key: string]: unknown }

/** 每次 editor 调用都带回的传输层身份(不含 token)。 */
export interface BridgeTransport { host: string; port: number; descriptorPath: string; protocolVersion: number; sessionId: string; instanceId: string | null; projectId: string | null; projectPath: string | null; pid: number | null; godotVersion: string | null }

/**
 * Editor 场景/节点结果的公共信封字段(插件侧产出,这里只声明形状)。
 * objectId 是十进制字符串:Godot 的 ObjectID 是 int64,作为 JSON 数字会被 JS 截断;
 * 它只在本 bridge session 内有效,不能当永久 ID。
 */
export interface EditorEnvelope {
  context: "editor";
  source: string;
  projectId: string;
  projectPath: string;
  instanceId: string;
  sessionId: string;
  editorPid: number;
  godotVersion: string;
  scenePath: string;
  objectId: string | null;
  isValid: boolean;
  isDirty: boolean | null;
  isDirtyReason?: string;
  [key: string]: unknown;
}

export interface EditorSceneTreeParams { projectPath?: string; nodePath?: string; maxDepth?: number; maxNodes?: number; includeInternal?: boolean; includeGroups?: boolean }
export interface EditorNodeInfoParams { projectPath?: string; nodePath?: string; properties?: "none" | "list" | "values"; propertyNames?: string[]; maxProperties?: number }
export interface EditorLayoutParams { projectPath?: string; nodePath?: string; nodePaths?: string[] }

/** 插件侧错误码里可以原样上抛的(其余视为协议层问题)。 */
const PASS_THROUGH: ReadonlySet<string> = new Set<ErrorCode>([
  "BRIDGE_UNAVAILABLE", "BRIDGE_DISCONNECTED", "BRIDGE_TIMEOUT", "BRIDGE_PROTOCOL_ERROR",
  "EDITOR_NO_SCENE_OPEN", "EDITOR_SCENE_ROOT_MISSING", "EDITOR_NODE_NOT_FOUND",
  "EDITOR_OBJECT_INVALID", "EDITOR_RESPONSE_TOO_LARGE",
]);

export class NativeBridgeService {
  private readonly clients = new Map<string, NativeBridgeClient>();
  constructor(private readonly factory: (projectRoot: string) => NativeBridgeClient, private readonly descriptorPathFor: (projectRoot: string) => string = defaultDescriptorPath) {}

  async getCapabilities(root: string): Promise<{ data: ProjectCapabilities; transport: BridgeTransport }> {
    return this.editorCall<ProjectCapabilities>(root, "project_capabilities", {});
  }

  async getEditorScene(root: string): Promise<{ data: EditorEnvelope; transport: BridgeTransport }> {
    return this.editorCall<EditorEnvelope>(root, "editor_scene_info", {});
  }

  async getEditorTree(root: string, params: EditorSceneTreeParams = {}): Promise<{ data: EditorEnvelope; transport: BridgeTransport }> {
    return this.editorCall<EditorEnvelope>(root, "editor_scene_tree", compact(params));
  }

  async getEditorNode(root: string, params: EditorNodeInfoParams = {}): Promise<{ data: EditorEnvelope; transport: BridgeTransport }> {
    return this.editorCall<EditorEnvelope>(root, "editor_node_info", compact(params));
  }

  async getEditorLayout(root: string, params: EditorLayoutParams = {}): Promise<{ data: EditorEnvelope; transport: BridgeTransport }> {
    return this.editorCall<EditorEnvelope>(root, "editor_control_layout", compact(params));
  }

  private clientFor(root: string): { client: NativeBridgeClient; descriptorPath: string } {
    const key = path.resolve(root);
    let client = this.clients.get(key);
    if (!client) { client = this.factory(key); this.clients.set(key, client); }
    return { client, descriptorPath: this.descriptorPathFor(key) };
  }

  /**
   * 唯一出口:identity 校验 → 调用 → 传输信息 → 错误码归一。
   * descriptor 里的 projectPath 必须与本次请求的项目根一致,否则明确报 EDITOR_INSTANCE_MISMATCH,
   * 而不是悄悄读到"另一个 Editor 的场景"。
   */
  private async editorCall<T extends object>(root: string, method: string, params: Record<string, unknown>): Promise<{ data: T & EditorEnvelope; transport: BridgeTransport }> {
    const { client, descriptorPath } = this.clientFor(root);
    // 先取一份"不抛异常"的 descriptor 用于错误详情;身份校验放在 try 里,这样
    // descriptor 缺失/非法也会被归一成结构化错误码,而不是以 INTERNAL 冒到 MCP 层。
    const bestEffort = safeDescriptor(descriptorPath);
    let descriptor: BridgeDescriptor;
    let data: T & EditorEnvelope;
    try {
      descriptor = assertSameProject(descriptorPath, root);
      data = await client.call<T & EditorEnvelope>(method, params);
    } catch (e) {
      if (e instanceof GodotMcpError) throw e;
      throw toGodotError(e, method, bestEffort);
    }
    if (data && typeof data === "object" && typeof (data as { projectPath?: unknown }).projectPath === "string" && !samePath((data as { projectPath: string }).projectPath, root)) {
      throw new GodotMcpError("EDITOR_INSTANCE_MISMATCH", `The connected Godot editor serves a different project than requested`, {
        requested: path.resolve(root), editorProjectPath: (data as { projectPath: string }).projectPath, descriptorPath, bridgeMethod: method,
      });
    }
    return { data, transport: transportOf(descriptor, descriptorPath) };
  }
}

export function defaultDescriptorPath(root: string): string {
  return process.env["GODOT_AI_MCP_BRIDGE_FILE"] ?? path.join(root, ".godot-ai-mcp", "bridge.json");
}

function transportOf(d: BridgeDescriptor, descriptorPath: string): BridgeTransport {
  return {
    host: d.host, port: d.port, descriptorPath,
    protocolVersion: d.protocolVersion ?? BRIDGE_PROTOCOL_VERSION,
    sessionId: d.sessionId,
    instanceId: d.instanceId ?? null,
    projectId: d.projectId ?? null,
    projectPath: d.projectPath ?? null,
    pid: d.pid ?? null,
    godotVersion: d.godotVersion ?? null,
  };
}

/** descriptor 缺失/非法 → BRIDGE_UNAVAILABLE;项目不匹配 → EDITOR_INSTANCE_MISMATCH。 */
function assertSameProject(descriptorPath: string, root: string): BridgeDescriptor {
  const descriptor = readBridgeDescriptor(descriptorPath);
  if (descriptor.projectPath !== undefined && !samePath(descriptor.projectPath, root)) {
    throw new GodotMcpError("EDITOR_INSTANCE_MISMATCH", "The Godot Bridge descriptor belongs to a different project", {
      descriptorPath, requested: path.resolve(root), editorProjectPath: descriptor.projectPath, pid: descriptor.pid ?? null,
    });
  }
  return descriptor;
}

function toGodotError(e: unknown, method: string, descriptor: BridgeDescriptor | undefined): GodotMcpError {
  if (e instanceof GodotMcpError) return e;
  if (e instanceof NativeBridgeError) {
    const details = { bridgeMethod: method, bridgeCode: e.code, host: descriptor?.host ?? null, port: descriptor?.port ?? null, pid: descriptor?.pid ?? null, ...(e.details ?? {}) };
    if (PASS_THROUGH.has(e.code)) return new GodotMcpError(e.code as ErrorCode, e.message, details);
    return new GodotMcpError("BRIDGE_PROTOCOL_ERROR", `Godot editor bridge rejected ${method}: ${e.message}`, details);
  }
  return new GodotMcpError("BRIDGE_PROTOCOL_ERROR", `Unexpected editor bridge failure during ${method}: ${e instanceof Error ? e.message : String(e)}`, { bridgeMethod: method });
}

/** 只用于错误详情,失败返回 undefined,绝不抛。 */
function safeDescriptor(descriptorPath: string): BridgeDescriptor | undefined {
  try { return readBridgeDescriptor(descriptorPath); } catch { return undefined; }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  const x = norm(a); const y = norm(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function compact(params: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) { if (v !== undefined) out[k] = v; }
  return out;
}

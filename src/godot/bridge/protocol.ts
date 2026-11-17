import { randomUUID } from "node:crypto";

export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_BRIDGE_TIMEOUT_MS = 3_000;

export interface BridgeRequest { protocolVersion: number; requestId: string; token: string; method: string; params: Record<string, unknown> }
export interface BridgeResponse { protocolVersion: number; requestId: string; success: boolean; data?: unknown; error: BridgeErrorPayload | null }
export interface BridgeErrorPayload { code: string; message: string; details?: Record<string, unknown> }

/**
 * Editor → MCP 的非请求帧（推送）。与响应帧的唯一区别是没有 requestId、多一个 event。
 * 帧格式不变：[4 字节小端长度][UTF-8 JSON]。
 */
export interface BridgeEventFrame {
  protocolVersion: number;
  sessionId?: string;
  event: BridgeEvent;
}

export interface BridgeEvent {
  /** 单调递增，只在本次 Editor 会话内有效；Server 用它去重与补齐。 */
  seq: number;
  type: BridgeEventType;
  /** Unix 毫秒。 */
  at: number;
  data: Record<string, unknown>;
}

export const BRIDGE_EVENT_TYPES = [
  "scene_changed",
  "scene_closed",
  "scene_saved",
  "scene_tree_changed",
  "selection_changed",
  "history_changed",
  "log",
] as const;

export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[number];

/** 客户端内存里最多留多少条推送事件（权威数据仍在 Editor 环形缓冲）。 */
export const MAX_BUFFERED_EVENTS = 500;

export function makeRequest(token: string, method: string, params: Record<string, unknown> = {}): BridgeRequest {
  return { protocolVersion: BRIDGE_PROTOCOL_VERSION, requestId: randomUUID(), token, method, params };
}

/**
 * 帧头 = 4 字节**小端**无符号长度。
 * 由引擎决定,不由 Node 决定:插件用 PackedByteArray.encode_u32/decode_u32,
 * 这两个 API 固定小端(Godot 4.6.3 实测:encode_u32(65536) == [0,0,1,0])。
 * 之前写成 BE,插件把 BE 长度读成天文数字后直接断开连接 —— 这就是历史上的
 * "Godot Bridge connection closed"。
 */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_BRIDGE_MESSAGE_BYTES) throw new Error("Bridge message exceeds maximum size");
  const frame = Buffer.allocUnsafe(4 + body.length); frame.writeUInt32LE(body.length, 0); body.copy(frame, 4); return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]); const out: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_BRIDGE_MESSAGE_BYTES) throw new Error("Bridge message exceeds maximum size");
      if (this.buffer.length < length + 4) break;
      const body = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4);
      out.push(JSON.parse(body.toString("utf8")) as unknown);
    }
    return out;
  }
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  const v = value as Partial<BridgeResponse> | null;
  return !!v && typeof v === "object" && typeof v.protocolVersion === "number" && typeof v.requestId === "string" && typeof v.success === "boolean";
}

/**
 * 推送帧判定：没有 requestId，只有 event{seq,type,at,data}。
 * 与响应帧互斥，客户端据此分流，不会把事件当成某个请求的应答。
 */
export function isBridgeEvent(value: unknown): value is BridgeEventFrame {
  const v = value as Partial<BridgeEventFrame> | null;
  if (!v || typeof v !== "object" || typeof v.protocolVersion !== "number") return false;
  const event = v.event as Partial<BridgeEvent> | undefined;
  return !!event && typeof event === "object" && Number.isInteger(event.seq) && typeof event.type === "string" && typeof event.at === "number";
}

import fs from "node:fs";
import net from "node:net";
import { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_TIMEOUT_MS, FrameDecoder, isBridgeResponse, makeRequest, encodeFrame, type BridgeResponse } from "./protocol.js";

export class NativeBridgeError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); this.name = "NativeBridgeError"; }
}

/**
 * `.godot-ai-mcp/bridge.json`(插件在 Editor 启动时写入)。
 * 后四个字段是 T13-C1 新增的:它们让调用方能在不断言"某个 Editor"的情况下核对 PID / 项目 / 会话。
 */
export interface BridgeDescriptor {
  host: string;
  port: number;
  token: string;
  sessionId: string;
  projectPath: string;
  instanceId?: string;
  projectId?: string;
  pid?: number;
  godotVersion?: string;
  protocolVersion?: number;
}

export interface NativeBridgeClientOptions { descriptorPath: string; timeoutMs?: number }

/** 读取并校验 descriptor(不建立连接)。供工具层在发请求前核对项目/实例身份。 */
export function readBridgeDescriptor(descriptorPath: string): BridgeDescriptor {
  try {
    const raw = JSON.parse(fs.readFileSync(descriptorPath, "utf8")) as BridgeDescriptor;
    if (!raw.host || !Number.isInteger(raw.port) || !raw.token || !raw.sessionId) throw new Error("invalid descriptor");
    return raw;
  } catch (e) {
    throw new NativeBridgeError("BRIDGE_UNAVAILABLE", `Cannot read Godot Bridge descriptor: ${e instanceof Error ? e.message : String(e)}`, { descriptorPath });
  }
}

export class NativeBridgeClient {
  private socket?: net.Socket; private decoder = new FrameDecoder(); private pending = new Map<string, { resolve: (r: BridgeResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private descriptor?: BridgeDescriptor;
  constructor(private readonly options: NativeBridgeClientOptions) {}

  /** 连接后实际使用的 descriptor(含 pid/projectPath),调用方据此报告传输层身份。 */
  getDescriptor(): BridgeDescriptor | undefined { return this.descriptor; }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const descriptor = this.readDescriptor(); const socket = await this.connect(descriptor); const request = makeRequest(descriptor.token, method, params);
    const response = await new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request.requestId); reject(new NativeBridgeError("BRIDGE_TIMEOUT", `Bridge request timed out: ${method}`, { method, timeoutMs: this.options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS })); }, this.options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS);
      this.pending.set(request.requestId, { resolve, reject, timer }); socket.write(encodeFrame(request));
    });
    if (!response.success) throw new NativeBridgeError(response.error?.code ?? "BRIDGE_PROTOCOL_ERROR", response.error?.message ?? "Bridge request failed", response.error?.details);
    return response.data as T;
  }

  close(): void { this.socket?.destroy(); this.socket = undefined; this.decoder = new FrameDecoder(); }
  private readDescriptor(): BridgeDescriptor {
    const raw = readBridgeDescriptor(this.options.descriptorPath);
    if (raw.protocolVersion !== undefined && raw.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      throw new NativeBridgeError("BRIDGE_PROTOCOL_ERROR", `Bridge protocol mismatch: editor reports ${raw.protocolVersion}, client speaks ${BRIDGE_PROTOCOL_VERSION}`, { descriptorPath: this.options.descriptorPath });
    }
    this.descriptor = raw; return raw;
  }
  private connect(d: BridgeDescriptor): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed && this.descriptor?.sessionId === d.sessionId) return Promise.resolve(this.socket);
    this.close(); this.descriptor = d;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: d.host, port: d.port }); const fail = (e: Error) => { socket.destroy(); this.rejectPending(e); reject(new NativeBridgeError("BRIDGE_DISCONNECTED", e.message, { host: d.host, port: d.port, pid: d.pid ?? null })); };
      socket.once("connect", () => { this.socket = socket; resolve(socket); }); socket.once("error", fail); socket.on("close", () => { if (this.socket === socket) this.socket = undefined; this.rejectPending(new NativeBridgeError("BRIDGE_DISCONNECTED", "Godot Bridge connection closed", { host: d.host, port: d.port, pid: d.pid ?? null })); });
      socket.on("data", (chunk) => { try { for (const value of this.decoder.push(chunk)) this.handleResponse(value); } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); } });
    });
  }
  private handleResponse(value: unknown): void { if (!isBridgeResponse(value)) return; const p = this.pending.get(value.requestId); if (!p) return; clearTimeout(p.timer); this.pending.delete(value.requestId); p.resolve(value); }
  private rejectPending(error: Error): void { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(error); this.pending.delete(id); } }
}

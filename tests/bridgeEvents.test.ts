// 事件通道的协议与合并逻辑（单元层）。
//
// 这里用本地 TCP 假插件验证"帧分流 + 推送缓冲 + 环形缓冲补齐 + 按 seq 去重"，
// 它只是辅助证据；编辑器内的真实行为由 tests/editorBridgeWrite.real.test.ts
// 用真实 Godot Editor + 真实 UndoRedo 验证。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { FrameDecoder, encodeFrame, isBridgeEvent, isBridgeResponse } from "../src/godot/bridge/protocol.js";
import { NativeBridgeClient } from "../src/godot/bridge/client.js";
import { NativeBridgeService } from "../src/services/nativeBridgeService.js";

function makeDescriptor(root: string, port: number): string {
  const descriptorPath = path.join(root, ".vino-godot-mcp", "bridge.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, JSON.stringify({
    host: "127.0.0.1", port, token: "test-token", sessionId: "session-1", instanceId: "session-1",
    projectId: "bridge-events", projectPath: root, pid: 4242, protocolVersion: 1,
  }), "utf8");
  return descriptorPath;
}

interface FakePlugin { port: number; received: Array<{ method: string; params: Record<string, unknown> }>; close: () => Promise<void> }

/**
 * 假插件：按帧解析请求，先推一条不在应答里的 selection_changed（seq 3），再回 editor_events。
 * 这样能同时验证两件事：事件帧不会被当成某个请求的应答，且推送与补齐会按 seq 去重。
 */
async function startFakePlugin(root: string, buffered: Array<Record<string, unknown>>): Promise<FakePlugin> {
  const received: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        const request = frame as { requestId: string; method: string; params: Record<string, unknown> };
        received.push({ method: request.method, params: request.params });
        if (request.method === "editor_events") {
          socket.write(encodeFrame({ protocolVersion: 1, sessionId: "session-1", event: { seq: 3, type: "selection_changed", at: 3, data: { count: 1 } } }));
          const since = Number(request.params["sinceSeq"] ?? 0);
          const events = buffered.filter((event) => Number(event["seq"]) > since);
          socket.write(encodeFrame({
            protocolVersion: 1, requestId: request.requestId, success: true, error: null,
            data: { context: "editor", projectPath: root, events, nextSeq: 3, buffered: events.length, dropped: 0, state: { nextSeq: 3 } },
          }));
          continue;
        }
        socket.write(encodeFrame({
          protocolVersion: 1, requestId: request.requestId, success: true, error: null,
          data: { context: "editor", projectPath: root, scenePath: "res://a.tscn", changed: true },
        }));
      }
    });
    socket.on("error", () => { /* 测试结束时的连接重置不算失败 */ });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    received,
    // 不用 await server.close():它要等所有连接断开，而测试的清理顺序不保证。
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); return Promise.resolve(); },
  };
}

test("protocol: event frames and response frames never overlap", () => {
  const event = { protocolVersion: 1, sessionId: "s", event: { seq: 7, type: "log", at: 1, data: { level: "error" } } };
  const response = { protocolVersion: 1, requestId: "r1", success: true, data: {}, error: null };
  assert.equal(isBridgeEvent(event), true);
  assert.equal(isBridgeEvent(response), false);
  assert.equal(isBridgeResponse(event), false);
  assert.equal(isBridgeResponse(response), true);
  // 缺 seq / 缺 type 的"半事件"不能被当成事件吞掉
  assert.equal(isBridgeEvent({ protocolVersion: 1, event: { type: "log", at: 1 } }), false);
  assert.equal(isBridgeEvent({ protocolVersion: 1, event: { seq: 1, at: 1 } }), false);
});

test("client buffers pushed events; service merges them with the editor ring buffer by seq", { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bridge-events-"));
  fs.writeFileSync(path.join(root, "project.godot"), 'config_version=5\n', "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const buffered = [
    { seq: 1, type: "scene_tree_changed", at: 1, data: { nodeCount: 2 } },
    { seq: 2, type: "log", at: 2, data: { level: "error", message: "boom" } },
    { seq: 3, type: "selection_changed", at: 3, data: { count: 1 } },
  ];
  const plugin = await startFakePlugin(root, buffered);
  t.after(() => plugin.close());
  const descriptorPath = makeDescriptor(root, plugin.port);

  // --- 客户端层：推送事件进缓冲，不污染应答 ---
  const client = new NativeBridgeClient({ descriptorPath, timeoutMs: 5_000 });
  t.after(() => client.close());
  await client.call("project_capabilities", {});
  // 再来一次 editor_events：假插件在应答前先推 seq=3（应答里也带 seq=3，验证去重）
  await client.call("editor_events", { sinceSeq: 0 });
  const pushed = client.drainEvents();
  assert.equal(pushed.length, 1, "恰好一条推送事件");
  assert.equal(pushed[0]!.seq, 3);
  assert.equal(client.drainEvents().length, 0, "drain 之后必须清空");
  assert.equal(client.eventsState().received, 1);

  // --- 服务层：推送缓冲 + 环形缓冲合并，按 seq 去重 ---
  const service = new NativeBridgeService(
    (projectRoot) => new NativeBridgeClient({ descriptorPath: path.join(projectRoot, ".vino-godot-mcp", "bridge.json"), timeoutMs: 5_000 }),
    (projectRoot) => path.join(projectRoot, ".vino-godot-mcp", "bridge.json"),
  );
  // 制造一条"推送已到、还没被取走"的事件
  const serviceClient = new NativeBridgeClient({ descriptorPath, timeoutMs: 5_000 });
  t.after(() => serviceClient.close());
  await serviceClient.call("project_capabilities", {});

  const { data } = await service.getEditorEvents(root, { sinceSeq: 0, limit: 100 });
  assert.deepEqual(data.events.map((event) => event.seq), [1, 2, 3], "按 seq 升序且 seq=3 只出现一次");
  assert.equal(data.returned, 3);
  assert.equal(data.hasMore, false);
  assert.equal(data.sources.merged, 3);

  // sinceSeq 游标：只要更新的
  const page = await service.getEditorEvents(root, { sinceSeq: 2, limit: 100 });
  assert.deepEqual(page.data.events.map((event) => event.seq), [3]);

  // types 过滤
  const logs = await service.getEditorEvents(root, { sinceSeq: 0, types: ["log"] });
  assert.deepEqual(logs.data.events.map((event) => event.type), ["log"]);

  // limit 截断 + hasMore
  const limited = await service.getEditorEvents(root, { sinceSeq: 0, limit: 2 });
  assert.equal(limited.data.returned, 2);
  assert.equal(limited.data.hasMore, true);

  // 写工具的 valueType 编码必须真的发到插件侧
  await service.setEditorNodeProperty(root, { nodePath: "World/Player", property: "position", value: { x: 10, y: 20 }, valueType: "Vector2" });
  const write = plugin.received.filter((entry) => entry.method === "editor_set_node_property").at(-1);
  assert.deepEqual(write?.params, { nodePath: "World/Player", property: "position", value: { valueType: "Vector2", value: { x: 10, y: 20 } } });
});

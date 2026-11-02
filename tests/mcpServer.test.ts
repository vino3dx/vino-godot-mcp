// 端到端:用官方 MCP 客户端(@modelcontextprotocol/client)经 stdio 连接真实的编译产物 dist/src/index.js。
// 这是唯一能证明"MCP Client 可以连接并调用工具"的测试,其余测试都在进程内。
// 覆盖两个协议 era(见 serveStdio):2025 旧协议 initialize 与现代 2026-07-28 server/discover。
// 不依赖 Godot。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const SERVER_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.js");

interface TextBlock { type: string; text?: string }

function textOf(result: unknown): string {
  const content = (result as { content?: TextBlock[] }).content ?? [];
  const block = content.find((c) => c.type === "text");
  assert.ok(block?.text !== undefined, `expected a text content block, got ${JSON.stringify(result)}`);
  return block.text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (check()) return;
    await sleep(25);
  }
}

/** 起一个真实 server 子进程并连上;返回已连接的 client 与它累积的 stderr 日志。 */
async function connectClient(mode: "legacy" | "auto"): Promise<{ client: Client; logs: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: path.resolve(path.dirname(SERVER_ENTRY), "../.."),
    stderr: "pipe",
    env: { ...getDefaultEnvironment(), GODOT_AI_MCP_LOG: "debug" },
  });

  const stderr = transport.stderr;
  assert.ok(stderr, "stderr pipe should be available before start()");
  let logs = "";
  stderr.on("data", (c: Buffer) => { logs += c.toString(); });

  const client = new Client(
    { name: "godot-ai-mcp-e2e", version: "0.0.0" },
    mode === "auto" ? { versionNegotiation: { mode: "auto" } } : undefined,
  );
  // connect 成功本身就证明 stdout 是干净的:任何多余输出都会破坏 JSON-RPC 帧。
  await client.connect(transport);
  return { client, logs: () => logs };
}

test("real MCP client (2025-era handshake): tools/list carries JSON Schema, unified error envelope", async (t) => {
  const { client, logs } = await connectClient("legacy");
  t.after(() => client.close());

  assert.equal(client.getProtocolEra(), "legacy");

  // --- tools/list:验证 JSON Schema 真的上了线(这是旧占位适配层做不到的) ---
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    "asset_get_info", "asset_list", "class_get_info", "class_search", "class_validate_member", "editor_get_layout", "editor_get_node", "editor_get_scene", "editor_get_tree", "project_apply_changes", "project_capabilities", "project_get_config", "project_input_get", "project_input_update", "project_set_config", "project_validate",
    "resource_add_or_update_external", "resource_get_info", "resource_update_property",
    "runtime_capture_screenshot", "runtime_check_addon_status", "runtime_export_project", "runtime_get_session", "runtime_get_version", "runtime_inspect_ui", "runtime_read_session_logs", "runtime_run_project", "runtime_run_scene", "runtime_start_session", "runtime_stop_session", "runtime_visual_debug",
    "scene_add_node", "scene_add_to_group", "scene_add_visual_node", "scene_analyze_connections", "scene_connect_signal", "scene_disconnect_signal",
    "scene_find_nodes", "scene_get_connections", "scene_get_node_info", "scene_get_tree", "scene_instantiate_scene", "scene_remove_from_group", "scene_remove_node",
    "scene_reparent_node", "scene_set_ui_layout", "scene_update_node_property", "scene_update_signal_connection",
    "script_analyze", "script_create", "script_find_references", "script_get_info", "script_project_graph", "script_update_export_default", "script_update_function",
    "shader_get_info", "shader_update_uniform_default",
    "utility_ping", "utility_task_status",
  ]);

  const ping = tools.find((x) => x.name === "utility_ping");
  assert.ok(ping, "utility_ping must be advertised");
  assert.equal(ping.description?.includes("Health check"), true);
  const schema = ping.inputSchema as { type?: string; properties?: Record<string, unknown> };
  assert.equal(schema.type, "object");
  assert.ok(schema.properties && "echo" in schema.properties, "inputSchema must expose the `echo` property");

  // --- tools/call 正常路径 ---
  const ok = await client.callTool({ name: "utility_ping", arguments: { echo: "hi" } });
  const payload = JSON.parse(textOf(ok)) as { ok: boolean; data: { pong: boolean; echo: string; targetGodot: string } };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.pong, true);
  assert.equal(payload.data.echo, "hi");
  assert.equal(payload.data.targetGodot, "4.6.3");

  // --- 错误路径必须保持项目统一错误信封(INVALID_ARGUMENT 由 ToolHost 产生,不是 SDK 的格式) ---
  const badArgs = await client.callTool({ name: "utility_ping", arguments: { unknown_param: 1 } });
  assert.equal(badArgs.isError, true);
  const badPayload = JSON.parse(textOf(badArgs)) as { ok: boolean; error: { code: string; details?: { errors?: string[] } } };
  assert.equal(badPayload.ok, false);
  assert.equal(badPayload.error.code, "INVALID_ARGUMENT");
  assert.match(JSON.stringify(badPayload.error.details), /unknown parameter/);

  // --- 未知工具:由 SDK 在协议层直接拒绝(JSON-RPC -32602),不会到达 ToolHost ---
  // 因此 ToolHost 的 TOOL_NOT_FOUND 只在本进程内可达(见 toolHost.test.ts),这是预期行为,不去对抗 SDK。
  await assert.rejects(
    () => client.callTool({ name: "nope_tool", arguments: {} }),
    (e: unknown) => {
      assert.equal((e as { code?: number }).code, -32602);
      assert.match(String((e as Error).message), /not found/);
      return true;
    },
  );

  // --- 日志走 stderr,而不是 stdout ---
  await waitFor(() => logs().includes("listening on stdio"));
  assert.match(logs(), /\[godot-ai-mcp\] INFO .*listening on stdio/);
});

test("real MCP client (modern 2026-07-28 era): server/discover path works too", async (t) => {
  const { client } = await connectClient("auto");
  t.after(() => client.close());

  assert.equal(client.getProtocolEra(), "modern");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    "asset_get_info", "asset_list", "class_get_info", "class_search", "class_validate_member", "editor_get_layout", "editor_get_node", "editor_get_scene", "editor_get_tree", "project_apply_changes", "project_capabilities", "project_get_config", "project_input_get", "project_input_update", "project_set_config", "project_validate",
    "resource_add_or_update_external", "resource_get_info", "resource_update_property",
    "runtime_capture_screenshot", "runtime_check_addon_status", "runtime_export_project", "runtime_get_session", "runtime_get_version", "runtime_inspect_ui", "runtime_read_session_logs", "runtime_run_project", "runtime_run_scene", "runtime_start_session", "runtime_stop_session", "runtime_visual_debug",
    "scene_add_node", "scene_add_to_group", "scene_add_visual_node", "scene_analyze_connections", "scene_connect_signal", "scene_disconnect_signal",
    "scene_find_nodes", "scene_get_connections", "scene_get_node_info", "scene_get_tree", "scene_instantiate_scene", "scene_remove_from_group", "scene_remove_node",
    "scene_reparent_node", "scene_set_ui_layout", "scene_update_node_property", "scene_update_signal_connection",
    "script_analyze", "script_create", "script_find_references", "script_get_info", "script_project_graph", "script_update_export_default", "script_update_function",
    "shader_get_info", "shader_update_uniform_default",
    "utility_ping", "utility_task_status",
  ]);

  const ok = await client.callTool({ name: "utility_ping", arguments: { echo: "modern" } });
  assert.equal((JSON.parse(textOf(ok)) as { data: { echo: string } }).data.echo, "modern");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/core/logger.js";
import { GodotMcpError } from "../src/core/errors.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { ToolHost, toMcpContent } from "../src/mcp/server/toolHost.js";
import { buildHost } from "../src/index.js";
import type { ToolDefinition } from "../src/types/index.js";

const quiet = createLogger("error", () => {});
const t = (name: string, handler: ToolDefinition["handler"]): ToolDefinition => ({
  name, domain: "utility", description: "d", annotations: { readOnly: true }, runtimeRequired: false, handler,
  inputSchema: { type: "object", required: ["x"], properties: { x: { type: "number" } } },
});

test("ok / invalid args / unknown tool / GodotMcpError / unexpected error", async () => {
  const reg = new ToolRegistry().registerAll([
    t("utility_ok", async (a) => ({ data: (a["x"] as number) * 2, message: "hi" })),
    t("utility_known", async () => { throw new GodotMcpError("FILE_NOT_FOUND", "nope", { path: "p" }); }),
    t("utility_bug", async () => { throw new TypeError("oops"); }),
  ]);
  const h = new ToolHost(reg, {}, quiet);
  assert.deepEqual(await h.callTool("utility_ok", { x: 2 }), { ok: true, data: 4, message: "hi" });
  const bad = await h.callTool("utility_ok", {});
  assert.ok(!bad.ok && bad.error.code === "INVALID_ARGUMENT");
  const nf = await h.callTool("nope_tool", {});
  assert.ok(!nf.ok && nf.error.code === "TOOL_NOT_FOUND");
  const k = await h.callTool("utility_known", { x: 1 });
  assert.ok(!k.ok && k.error.code === "FILE_NOT_FOUND" && k.error.details?.["path"] === "p");
  const b = await h.callTool("utility_bug", { x: 1 });
  assert.ok(!b.ok && b.error.code === "INTERNAL");
  assert.equal(toMcpContent(b).isError, true);
});

test("warnings are non-fatal hints, passed through to the result and the MCP content", async () => {
  const reg = new ToolRegistry().registerAll([
    t("utility_warn", async () => ({ data: { n: 1 }, warnings: ["EDITOR_CONFLICT_WARNING: scene is open in the editor"] })),
    t("utility_nowarn", async () => ({ data: { n: 1 }, warnings: [] })),
  ]);
  const h = new ToolHost(reg, {}, quiet);

  const w = await h.callTool("utility_warn", { x: 1 });
  assert.deepEqual(w, { ok: true, data: { n: 1 }, warnings: ["EDITOR_CONFLICT_WARNING: scene is open in the editor"] });
  const block = toMcpContent(w).content[0];
  assert.ok(block && block.type === "text");
  if (block.type === "text") {
    assert.equal(JSON.parse(block.text).warnings[0].startsWith("EDITOR_CONFLICT_WARNING"), true);
  }
  assert.equal(toMcpContent(w).isError, undefined);

  // 空数组不制造噪音
  assert.deepEqual(await h.callTool("utility_nowarn", { x: 1 }), { ok: true, data: { n: 1 } });
});

test("image is emitted as a second MCP content block and kept out of the text JSON", async () => {
  const reg = new ToolRegistry().registerAll([
    t("utility_img", async () => ({ data: { n: 1 }, image: { data: "AAAA", mimeType: "image/png" } })),
  ]);
  const h = new ToolHost(reg, {}, quiet);
  const r = await h.callTool("utility_img", { x: 1 });
  assert.ok(r.ok);
  const mc = toMcpContent(r);
  assert.equal(mc.content.length, 2);
  const text = mc.content[0];
  const img = mc.content[1];
  assert.ok(text && text.type === "text");
  assert.ok(img && img.type === "image");
  if (text.type === "text") assert.equal(JSON.parse(text.text).image, undefined);
  if (img.type === "image") {
    assert.equal(img.data, "AAAA");
    assert.equal(img.mimeType, "image/png");
  }
});

test("minimal real tools through the composition root", async () => {
  const h = buildHost(quiet);
  assert.deepEqual(h.listTools().map((x) => x.name).sort(), [
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
  const ping = await h.callTool("utility_ping", { echo: "hi" });
  assert.ok(ping.ok && (ping.data as { pong: boolean; echo: string }).pong && (ping.data as { echo: string }).echo === "hi");
  const st = await h.callTool("utility_task_status", {});
  assert.ok(st.ok && (st.data as { active: number }).active === 0);
});

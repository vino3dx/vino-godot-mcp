// P1-D 验收:一个固定 UI 场景必须能只用场景工具建成,结构存在于 .tscn,
// GDScript 只包含逻辑(不含 _ready 里 add_child / new() 建树)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { createAppContext, type AppContext } from "../src/services/context.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";

const quiet = createLogger("error", () => {});
const SCENE = "res://ui/main_menu.tscn";
const SCRIPT = "res://ui/main_menu.gd";

interface Fixture { dir: string; host: ToolHost<AppContext> }

function makeProject(t: { after: (fn: () => void) => void }): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-scene-first-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="SceneFirstFixture"\n');
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: Record<string, unknown> }).data;
}

test("a fixed UI panel is built as .tscn nodes, with logic-only GDScript", async (t) => {
  const { dir, host } = makeProject(t);

  // 1) 唯一的 bootstrap:最小 [gd_scene] + 根节点(本版本没有 scene_create)。
  ok(await host.callTool("script_create", {
    scriptPath: SCENE,
    content: '[gd_scene format=3]\n\n[node name="MainMenu" type="Control"]\n',
  }));

  // 2) 结构全部写进场景。
  for (const node of [
    { parentPath: ".", nodeType: "Panel", nodeName: "Panel" },
    { parentPath: "Panel", nodeType: "VBoxContainer", nodeName: "VBox" },
    { parentPath: "Panel/VBox", nodeType: "Label", nodeName: "Title" },
    { parentPath: "Panel/VBox", nodeType: "Button", nodeName: "StartButton" },
  ]) {
    ok(await host.callTool("scene_add_node", { path: SCENE, ...node }));
  }
  ok(await host.callTool("scene_set_ui_layout", {
    path: SCENE, nodePath: ".",
    layout: { anchor_right: "1.0", anchor_bottom: "1.0" },
  }));
  ok(await host.callTool("scene_update_node_property", {
    path: SCENE, nodePath: "Panel/VBox/Title", key: "text", value: '"Start Game"',
  }));

  // 3) 逻辑脚本:只有回调,没有建树代码。
  ok(await host.callTool("script_create", {
    scriptPath: SCRIPT,
    content: 'extends Control\n\nfunc _on_start_pressed() -> void:\n\tprint("start game")\n',
  }));

  // 4) 挂脚本 + 固定信号连接,都写进 .tscn。
  ok(await host.callTool("resource_add_or_update_external", {
    path: SCENE,
    resource: { id: "1_menu", type: "Script", path: SCRIPT },
  }));
  ok(await host.callTool("scene_update_node_property", {
    path: SCENE, nodePath: ".", key: "script", value: 'ExtResource("1_menu")',
  }));
  ok(await host.callTool("scene_connect_signal", {
    path: SCENE,
    sourcePath: "Panel/VBox/StartButton",
    signal: "pressed",
    targetPath: ".",
    method: "_on_start_pressed",
  }));

  // 5) 结构与连接都真实存在于文件里。
  const tree = ok(await host.callTool("scene_get_tree", { path: SCENE }));
  const scene = tree["tree"] as { nodes: Array<{ path: string; type?: string }>; connections: Array<Record<string, unknown>> };
  assert.deepEqual(
    scene.nodes.map((n) => `${n.path}:${n.type}`),
    [".:Control", "Panel:Panel", "Panel/VBox:VBoxContainer", "Panel/VBox/Title:Label", "Panel/VBox/StartButton:Button"],
  );
  assert.equal(scene.connections.length, 1);
  assert.equal(scene.connections[0]!["source"], "Panel/VBox/StartButton");
  assert.equal(scene.connections[0]!["signal"], "pressed");
  assert.equal(scene.connections[0]!["method"], "_on_start_pressed");

  const sceneText = fs.readFileSync(path.join(dir, "ui", "main_menu.tscn"), "utf8");
  assert.match(sceneText, /\[connection signal="pressed" from="Panel\/VBox\/StartButton" to="\." method="_on_start_pressed"\]/);
  assert.match(sceneText, /script = ExtResource\("1_menu"\)/);
  assert.equal((sceneText.match(/^\[node /gm) ?? []).length, 5);

  // 6) 脚本里不允许出现"运行时重建固定结构"的写法。
  const scriptText = fs.readFileSync(path.join(dir, "ui", "main_menu.gd"), "utf8");
  assert.equal(/add_child\s*\(/.test(scriptText), false, "fixed UI nodes must not be added at runtime");
  assert.equal(/\.new\s*\(/.test(scriptText), false, "fixed UI nodes must not be instantiated in code");
  assert.equal(/_ready\s*\(/.test(scriptText), false, "the fixture logic needs no _ready tree building");
});

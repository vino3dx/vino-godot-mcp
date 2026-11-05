import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SceneService } from "../src/services/sceneService.js";

const SCENE = `[gd_scene format=3]\n\n[ext_resource type="Script" path="res://root.gd" id="1"]\n\n[node name="Root" type="Node"]\nscript = ExtResource("1")\n\n[node name="Button" type="Button" parent="."]\n\n[connection signal="pressed" from="Button" to="." method="_on_pressed"]\n`;
test("scene connection query tools are registered and static analysis distinguishes known method", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "godot-signal-query-"));
  fs.writeFileSync(path.join(root, "project.godot"), "[application]\nconfig/name=\"x\"\n");
  fs.writeFileSync(path.join(root, "main.tscn"), SCENE); fs.writeFileSync(path.join(root, "root.gd"), "extends Node\nfunc _on_pressed() -> void:\n pass\n");
  const { buildHost } = await import("../src/index.js");
  // 显式传 env:不依赖开发机上的 VINO_GODOT_MCP_PRESET/_GROUPS(否则本用例会随环境失败)。
  const host = buildHost(undefined, { VINO_GODOT_MCP_PRESET: "full" });
  const q = await host.callTool("scene_get_connections", { projectPath: root, path: "res://main.tscn", sourcePath: "Button" });
  assert.equal(q.ok, true); assert.equal((q as { ok: true; data: { total: number } }).data.total, 1);
  const a = await host.callTool("scene_analyze_connections", { projectPath: root, path: "res://main.tscn" });
  assert.equal(a.ok, true); assert.ok(((a as { ok: true; data: { diagnostics: unknown[] } }).data.diagnostics).some((d: any) => d.code === "SIGNAL_UNVERIFIED"));
});

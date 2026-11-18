// T6:场景写侧工具(add / reparent / groups / instantiate / signal)与 script_create 的端到端测试。
// 夹具是 tests/fixture_project 的最小工程;每个用例先整目录拷到临时目录,仓库副本不被改动。
// 读回校验用 scene_get_tree;信号连接本轮直接读 .tscn 文本(T7 才补读侧工具)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { parseGodotResource, serializeGodotResource } from "../src/core/parser/index.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";

const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");
const quiet = createLogger("error", () => {});

interface Host { dir: string; host: ToolHost<AppContext> }

function makeHost(t: { after: (fn: () => void) => void }): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-t6-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  const success = r as { ok: true; data: unknown; message?: string };
  const data = (success.data ?? {}) as Record<string, unknown>;
  return success.message === undefined ? data : { ...data, message: success.message };
}

function err(r: ToolResult): { code: string; message: string; details?: Record<string, unknown> } {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }).error;
}

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8");
}

/** 写出的文本必须能被解析并逐字节还原(无损自检)。 */
function assertLossless(text: string): void {
  assert.equal(serializeGodotResource(parseGodotResource(text)), text);
}

async function nodePaths(host: ToolHost<AppContext>, scenePath = "res://scenes/main.tscn"): Promise<string[]> {
  const data = ok(await host.callTool("scene_get_tree", { path: scenePath }));
  return (data["tree"] as { nodes: Array<{ path: string }> }).nodes.map((n) => n.path);
}

// ────────────────────────────── scene_add_node ──────────────────────────────

test("scene_add_node: 正常路径 — 新节点插在父节点子树之后,属性写入段体,其余字节不变", async (t) => {
  const { dir, host } = makeHost(t);
  const r = ok(await host.callTool("scene_add_node", {
    path: "res://scenes/main.tscn",
    parentPath: "Player",
    nodeType: "CharacterBody2D",
    nodeName: "Enemy",
    properties: [{ name: "position", value: "Vector2(5, 6)" }],
  }));
  assert.equal(r["changed"], true);
  assert.equal(r["nodePath"], "Player/Enemy");
  assert.equal(r["nodeName"], "Enemy");

  const text = read(dir, "scenes/main.tscn");
  assertLossless(text);
  assert.ok(text.includes('[node name="Enemy" type="CharacterBody2D" parent="Player"]'));
  assert.ok(text.includes("position = Vector2(5, 6)"));
  assert.ok(text.includes('[ext_resource type="Script" path="res://scripts/player.gd" id="1_player"]'));
  assert.ok(text.includes('[connection signal="ready" from="Player" to="." method="_on_ready"]'));
  // 新段落在父节点子树之后、connection 之前
  assert.ok(text.indexOf('[node name="Enemy"') < text.indexOf("[connection"));
  assert.deepEqual(await nodePaths(host), [".", "Player", "Player/Sprite", "Player/Enemy"]);
});

test("scene_add_node: 错误路径 — 非法 nodeType / 父节点不存在 / 属性名是段头字段", async (t) => {
  const { host } = makeHost(t);
  assert.equal(
    err(await host.callTool("scene_add_node", { path: "res://scenes/main.tscn", parentPath: ".", nodeType: "Node2D; rm -rf", nodeName: "X" })).code,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    err(await host.callTool("scene_add_node", { path: "res://scenes/main.tscn", parentPath: "Ghost", nodeType: "Node2D", nodeName: "X" })).code,
    "INVALID_ARGUMENT",
  );
  assert.equal(
    err(await host.callTool("scene_add_node", {
      path: "res://scenes/main.tscn", parentPath: ".", nodeType: "Node2D", nodeName: "X",
      properties: [{ name: "groups", value: '["a"]' }],
    })).code,
    "INVALID_ARGUMENT",
  );
});

test("scene_add_node: 重名报错;autoRename=true 自动改名", async (t) => {
  const { dir, host } = makeHost(t);
  const dup = await host.callTool("scene_add_node", { path: "res://scenes/main.tscn", parentPath: "Player", nodeType: "Node2D", nodeName: "Sprite" });
  assert.equal(err(dup).code, "INVALID_ARGUMENT");
  assert.match(err(dup).message, /已存在同名节点/);

  const renamed = ok(await host.callTool("scene_add_node", {
    path: "res://scenes/main.tscn", parentPath: "Player", nodeType: "Node2D", nodeName: "Sprite", autoRename: true,
  }));
  assert.equal(renamed["nodeName"], "Sprite2");
  assert.ok(read(dir, "scenes/main.tscn").includes('[node name="Sprite2" type="Node2D" parent="Player"]'));
});

// ────────────────────────────── scene_reparent_node ──────────────────────────────

test("scene_reparent_node: 正常路径 — 整棵子树搬到新父节点下,parent 前缀全部改写", async (t) => {
  const { dir, host } = makeHost(t);
  ok(await host.callTool("scene_add_node", { path: "res://scenes/main.tscn", parentPath: ".", nodeType: "Node2D", nodeName: "Holder" }));
  ok(await host.callTool("scene_add_node", { path: "res://scenes/main.tscn", parentPath: "Holder", nodeType: "Marker2D", nodeName: "Leaf" }));

  const r = ok(await host.callTool("scene_reparent_node", {
    path: "res://scenes/main.tscn", nodePath: "Holder", newParentPath: "Player",
  }));
  assert.equal(r["movedNodes"], 2);
  assert.equal(r["nodePath"], "Player/Holder");

  const text = read(dir, "scenes/main.tscn");
  assertLossless(text);
  assert.ok(text.includes('[node name="Holder" type="Node2D" parent="Player"]'));
  assert.ok(text.includes('[node name="Leaf" type="Marker2D" parent="Player/Holder"]'));
  assert.deepEqual(await nodePaths(host), [".", "Player", "Player/Sprite", "Player/Holder", "Player/Holder/Leaf"]);

  // 幂等:按新路径再次移动到同一父节点 → 不改动文件(也不会把子树重排到兄弟末尾)
  const again = ok(await host.callTool("scene_reparent_node", { path: "res://scenes/main.tscn", nodePath: "Player/Holder", newParentPath: "Player" }));
  assert.equal(again["changed"], false);
  assert.equal(again["movedNodes"], 0);
  assert.equal(again["connections"], 0);
});

test("scene_reparent_node: D2 — 引用被移动子树的 [connection] 的 from/to 路径同步改写", async (t) => {
  const { dir, host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  ok(await host.callTool("scene_add_node", { path: p, parentPath: ".", nodeType: "Node2D", nodeName: "Holder" }));
  ok(await host.callTool("scene_add_node", { path: p, parentPath: "Holder", nodeType: "Marker2D", nodeName: "Leaf" }));
  // 两条连接都落在被移动的子树里(命中子孙路径 + 命中根路径),另有一条指向子树之外(必须保持原样)
  ok(await host.callTool("scene_connect_signal", { path: p, sourcePath: "Holder/Leaf", signal: "ready", targetPath: "Holder", method: "_on_leaf_ready" }));
  ok(await host.callTool("scene_connect_signal", { path: p, sourcePath: "Holder", signal: "tree_exited", targetPath: ".", method: "_on_holder_exited" }));

  const r = ok(await host.callTool("scene_reparent_node", { path: p, nodePath: "Holder", newParentPath: "Player" }));
  assert.equal(r["connections"], 2, "两条引用被移动路径的连接都要回报为已改写");

  const text = read(dir, "scenes/main.tscn");
  assertLossless(text);
  assert.ok(text.includes('[connection signal="ready" from="Player/Holder/Leaf" to="Player/Holder" method="_on_leaf_ready"]'));
  assert.ok(text.includes('[connection signal="tree_exited" from="Player/Holder" to="." method="_on_holder_exited"]'));
  assert.ok(!text.includes('from="Holder'), "旧路径前缀必须全部消失,否则引擎会静默丢弃连接");
  assert.ok(text.includes('[connection signal="ready" from="Player" to="." method="_on_ready"]'), "子树外的连接不得被改写");

  // 读回:连接仍能按新节点路径解析
  const conns = ok(await host.callTool("scene_get_connections", { path: p }));
  const seen = (conns["connections"] as Array<{ source: string; target: string; signal: string }>).map((c) => `${c.source}|${c.signal}|${c.target}`);
  assert.ok(seen.includes("Player/Holder/Leaf|ready|Player/Holder"));
  assert.ok(seen.includes("Player/Holder|tree_exited|."));
});

test("scene_reparent_node: 错误路径 — 移入自身子孙 / 节点不存在 / 移动根节点 / keepGlobalTransform", async (t) => {
  const { host } = makeHost(t);
  const args = { path: "res://scenes/main.tscn", nodePath: "Player", newParentPath: "Player/Sprite" };
  assert.equal(err(await host.callTool("scene_reparent_node", args)).code, "INVALID_ARGUMENT");
  assert.match(err(await host.callTool("scene_reparent_node", args)).message, /自身或自己的子孙/);

  assert.equal(err(await host.callTool("scene_reparent_node", { path: "res://scenes/main.tscn", nodePath: "Ghost", newParentPath: "." })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("scene_reparent_node", { path: "res://scenes/main.tscn", nodePath: ".", newParentPath: "Player" })).code, "INVALID_ARGUMENT");
  assert.equal(
    err(await host.callTool("scene_reparent_node", { path: "res://scenes/main.tscn", nodePath: "Sprite", newParentPath: ".", keepGlobalTransform: true })).code,
    "INVALID_ARGUMENT",
  );
});

// ────────────────────────── scene_add_to_group / scene_remove_from_group ──────────────────────────

test("group 工具: 正常路径 — 加组累加、幂等、移除、清空后删除 groups 属性", async (t) => {
  const { dir, host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  const add = ok(await host.callTool("scene_add_to_group", { path: p, nodePath: "Player", group: "enemies" }));
  assert.equal(add["status"], "added");
  assert.ok(read(dir, "scenes/main.tscn").includes('[node name="Player" type="CharacterBody2D" parent="." groups=["enemies"]]'));

  const add2 = ok(await host.callTool("scene_add_to_group", { path: p, nodePath: "Player", group: "targets" }));
  assert.deepEqual(add2["groups"], ["enemies", "targets"]);
  assert.ok(read(dir, "scenes/main.tscn").includes('groups=["enemies", "targets"]'));
  const tree = ok(await host.callTool("scene_get_tree", { path: p }));
  assert.deepEqual((tree["tree"] as { nodes: Array<{ path: string; groups: string[] }> }).nodes.find((n) => n.path === "Player")?.groups, ["enemies", "targets"]);

  const dupe = ok(await host.callTool("scene_add_to_group", { path: p, nodePath: "Player", group: "enemies" }));
  assert.equal(dupe["status"], "already_in_group");
  assert.equal(dupe["changed"], false);
  assert.match(String(dupe["message"]), /already_in_group/);

  const rm = ok(await host.callTool("scene_remove_from_group", { path: p, nodePath: "Player", group: "enemies" }));
  assert.equal(rm["status"], "removed");
  assert.ok(read(dir, "scenes/main.tscn").includes('groups=["targets"]'));

  const rmLast = ok(await host.callTool("scene_remove_from_group", { path: p, nodePath: "Player", group: "targets" }));
  assert.deepEqual(rmLast["groups"], []);
  const text = read(dir, "scenes/main.tscn");
  assertLossless(text);
  assert.ok(text.includes('[node name="Player" type="CharacterBody2D" parent="."]'));
  assert.ok(!text.includes("groups="));
});

test("group 工具: 错误/提示路径 — 节点不存在 / group 为空 / 移除不存在的组", async (t) => {
  const { host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  assert.equal(err(await host.callTool("scene_add_to_group", { path: p, nodePath: "Ghost", group: "g" })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("scene_remove_from_group", { path: p, nodePath: "Player", group: "  " })).code, "INVALID_ARGUMENT");
  const missing = ok(await host.callTool("scene_remove_from_group", { path: p, nodePath: "Player", group: "nope" }));
  assert.equal(missing["status"], "not_in_group");
  assert.equal(missing["changed"], false);
  assert.match(String(missing["message"]), /not_in_group/);
});

// ────────────────────────────── scene_instantiate_scene ──────────────────────────────

test("scene_instantiate_scene: 正常路径 — 写 ext_resource + instance 引用,不展开子场景节点", async (t) => {
  const { dir, host } = makeHost(t);
  const r = ok(await host.callTool("scene_instantiate_scene", {
    path: "res://scenes/main.tscn", parentPath: ".", instanceScenePath: "res://scenes/child.tscn",
  }));
  assert.equal(r["nodePath"], "Child");
  assert.equal(r["instanceId"], "3_mcp");
  assert.equal(r["instancePath"], "res://scenes/child.tscn");

  const text = read(dir, "scenes/main.tscn");
  assertLossless(text);
  assert.ok(text.includes('[ext_resource type="PackedScene" path="res://scenes/child.tscn" id="3_mcp"]'));
  assert.ok(text.includes('[node name="Child" type="Node2D" parent="." instance=ExtResource("3_mcp")]'));

  const paths = await nodePaths(host);
  assert.ok(paths.includes("Child"));
  assert.ok(!paths.includes("Child/Marker"), "子场景的子节点不得被展开写进本文件");
  assert.ok(!text.includes("Marker"), "子场景内容不得展开");
});

test("scene_instantiate_scene: 错误路径 — 自己实例化自己 / 被实例化场景不存在 / 父节点不存在 / 重名", async (t) => {
  const { host } = makeHost(t);
  const base = { path: "res://scenes/main.tscn", parentPath: "." };
  const cyclic = err(await host.callTool("scene_instantiate_scene", { ...base, instanceScenePath: "res://scenes/main.tscn" }));
  assert.equal(cyclic.code, "INVALID_ARGUMENT");
  assert.match(cyclic.message, /循环实例化/);

  assert.equal(err(await host.callTool("scene_instantiate_scene", { ...base, instanceScenePath: "res://scenes/ghost.tscn" })).code, "FILE_NOT_FOUND");
  assert.equal(err(await host.callTool("scene_instantiate_scene", { path: "res://scenes/main.tscn", parentPath: "Ghost", instanceScenePath: "res://scenes/child.tscn" })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("scene_instantiate_scene", { ...base, instanceScenePath: "res://scenes/child.tscn", nodeName: "Player" })).code, "INVALID_ARGUMENT");
});

// ────────────────────────────── script_create ──────────────────────────────

test("script_create: 正常路径 — 新建脚本(含目录)、dryRun 不落盘", async (t) => {
  const { dir, host } = makeHost(t);
  const dry = ok(await host.callTool("script_create", {
    scriptPath: "res://scripts/dry_run.gd", content: "extends Node\n", dryRun: true,
  }));
  assert.equal(dry["changed"], true);
  assert.ok(!fs.existsSync(path.join(dir, "scripts", "dry_run.gd")));

  const r = ok(await host.callTool("script_create", {
    scriptPath: "res://scripts/nested/new_thing.gd", content: "extends Node2D\n\n@export var hp: int = 3\n",
  }));
  assert.equal(r["changed"], true);
  assert.equal(r["resPath"], "res://scripts/nested/new_thing.gd");
  assert.equal(read(dir, "scripts/nested/new_thing.gd"), "extends Node2D\n\n@export var hp: int = 3\n");
});

test("script_create: 错误路径 — 已存在且 overwrite=false / 越界路径 / 缺 content", async (t) => {
  const { dir, host } = makeHost(t);
  const existing = err(await host.callTool("script_create", { scriptPath: "res://scripts/player.gd", content: "extends Node\n" }));
  assert.equal(existing.code, "INVALID_ARGUMENT");
  assert.match(existing.message, /overwrite=false/);
  assert.ok(read(dir, "scripts/player.gd").includes("@export var speed"));

  const overwritten = ok(await host.callTool("script_create", { scriptPath: "res://scripts/player.gd", content: "extends Node\n", overwrite: true }));
  assert.equal(overwritten["changed"], true);
  assert.equal(read(dir, "scripts/player.gd"), "extends Node\n");

  assert.equal(err(await host.callTool("script_create", { scriptPath: "res://../escape.gd", content: "x" })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("script_create", { scriptPath: "res://scripts/no_content.gd" })).code, "INVALID_ARGUMENT");
});

// ────────────────────── scene_connect_signal / scene_disconnect_signal ──────────────────────

test("scene_connect_signal: 正常路径 — 写入 [connection] 段(文本验证),flags 0 不写该字段", async (t) => {
  const { dir, host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  const r = ok(await host.callTool("scene_connect_signal", {
    path: p, sourcePath: "Player/Sprite", signal: "ready", targetPath: "Player", method: "_on_sprite_ready",
  }));
  assert.equal(r["status"], "connected");
  assert.equal(r["flags"], 0);

  let text = read(dir, "scenes/main.tscn");
  assertLossless(text);
  assert.ok(text.includes('[connection signal="ready" from="Player/Sprite" to="Player" method="_on_sprite_ready"]'));
  assert.ok(!text.includes("flags="));
  assert.ok(text.includes('[connection signal="ready" from="Player" to="." method="_on_ready"]')); // 既有连接保留

  // D3 之后信号名会被 ClassDB 校验,所以这里用一个真实存在的信号(Sprite2D 继承自 Node 的 tree_exited)
  const flagged = ok(await host.callTool("scene_connect_signal", {
    path: p, sourcePath: "Player/Sprite", signal: "tree_exited", targetPath: ".", method: "_on_sprite_exited", flags: 3,
  }));
  assert.equal(flagged["flags"], 3);
  text = read(dir, "scenes/main.tscn");
  assertLossless(text);
  assert.ok(text.includes('[connection signal="tree_exited" from="Player/Sprite" to="." method="_on_sprite_exited" flags=3]'));
  // connection 段在 node 段之后
  assert.ok(text.lastIndexOf("[connection") > text.lastIndexOf("[node"));
});

test("scene_connect_signal: 错误路径 — 重复连接 / 节点不存在 / 非法 signal / flags 非法", async (t) => {
  const { host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  const dup = err(await host.callTool("scene_connect_signal", { path: p, sourcePath: "Player", signal: "ready", targetPath: ".", method: "_on_ready" }));
  assert.equal(dup.code, "INVALID_ARGUMENT");
  assert.match(dup.message, /连接已存在/);

  assert.equal(err(await host.callTool("scene_connect_signal", { path: p, sourcePath: "Ghost", signal: "ready", targetPath: ".", method: "_x" })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("scene_connect_signal", { path: p, sourcePath: "Player", signal: "my signal", targetPath: ".", method: "_x" })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("scene_connect_signal", { path: p, sourcePath: "Player", signal: "ready2", targetPath: ".", method: "_x", flags: -1 })).code, "INVALID_ARGUMENT");
});

test("scene_connect_signal: D3 — 不存在的信号名要么被拦截,要么被明确标注为未验证(绝不报 verified)", async (t) => {
  const { host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  // 引擎可用 → 硬拦截;引擎不可用 → 降级为警告并回报 status=unverified。两种情况都不得报 verified。
  const r = await host.callTool("scene_connect_signal", {
    path: p, sourcePath: "Player", signal: "no_such_signal_xyz", targetPath: ".", method: "_x",
  });
  if (r.ok) {
    const validation = (r.data as Record<string, unknown>)["signalValidation"] as { status: string; signal: string };
    assert.equal(validation.status, "unverified", "ClassDB 不可用时必须如实标注未验证,不能假装通过");
    assert.equal(validation.signal, "no_such_signal_xyz");
    assert.ok((r.warnings ?? []).length > 0, "未验证的信号必须带 warning");
  } else {
    assert.equal(r.error.code, "INVALID_ARGUMENT");
    assert.match(r.error.message, /has no signal 'no_such_signal_xyz'/);
  }
});

test("scene_disconnect_signal: 正常路径删除连接;不存在时明确提示且不报错", async (t) => {
  const { dir, host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  const r = ok(await host.callTool("scene_disconnect_signal", { path: p, sourcePath: "Player", signal: "ready", targetPath: ".", method: "_on_ready", confirm: true }));
  assert.equal(r["status"], "disconnected");
  const text = read(dir, "scenes/main.tscn");
  assertLossless(text);
  assert.ok(!text.includes("[connection"));

  const missing = ok(await host.callTool("scene_disconnect_signal", { path: p, sourcePath: "Player", signal: "ready", targetPath: ".", method: "_on_ready", confirm: true }));
  assert.equal(missing["status"], "not_found");
  assert.equal(missing["changed"], false);
  assert.match(String(missing["message"]), /not_found/);

  assert.equal(err(await host.callTool("scene_disconnect_signal", { path: p, sourcePath: "Player", signal: "1bad", targetPath: ".", method: "_x", confirm: true })).code, "INVALID_ARGUMENT");
});

test("scene_update_signal_connection: 精确更新、保留 flags、dryRun 与重复保护", async (t) => {
  const { dir, host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  const dry = ok(await host.callTool("scene_update_signal_connection", {
    path: p, sourcePath: "Player", signal: "ready", targetPath: ".", method: "_on_ready", newMethod: "_on_new", dryRun: true,
  }));
  assert.equal(dry["changed"], true);
  assert.ok(read(dir, "scenes/main.tscn").includes('method="_on_ready"'));

  const updated = ok(await host.callTool("scene_update_signal_connection", {
    path: p, sourcePath: "Player", signal: "ready", targetPath: ".", method: "_on_ready", newMethod: "_on_new", flags: 1,
  }));
  assert.equal(updated["updated"], true);
  assert.equal((updated["connection"] as { method: string }).method, "_on_new");
  const text = read(dir, "scenes/main.tscn");
  assert.ok(text.includes('signal="ready" from="Player" to="." method="_on_new" flags=3'));
  assert.ok(!text.includes('method="_on_ready"'));
  assertLossless(text);

  ok(await host.callTool("scene_connect_signal", { path: p, sourcePath: "Player", signal: "tree_exited", targetPath: ".", method: "_other" }));
  const duplicate = err(await host.callTool("scene_update_signal_connection", {
    path: p, sourcePath: "Player", signal: "tree_exited", targetPath: ".", method: "_other", newSignal: "ready", newMethod: "_on_new",
  }));
  assert.equal(duplicate.code, "INVALID_ARGUMENT");
});

// ────────────── P2:写工具回报结构化静态前后值(change / created / removed / moved / instantiated) ──────────────
//
// 这些值取自文件文本(本套工具不启动引擎),不是布局后的真实值;Control 的真实位置由 runtime_inspect_ui 提供。

test("scene_update_node_property: change 回报文件静态前后值(dryRun 也给出)", async (t) => {
  const { dir, host } = makeHost(t);
  const p = "res://scenes/main.tscn";

  const dry = ok(await host.callTool("scene_update_node_property", {
    path: p, nodePath: "Player", key: "position", value: "Vector2(1, 2)", dryRun: true,
  }));
  assert.deepEqual(dry["change"], {
    property: "position",
    before: { raw: "Vector2(0, 0)", value: { type: "Vector2", v: [0, 0] } },
    after: { raw: "Vector2(1, 2)", value: { type: "Vector2", v: [1, 2] } },
    inFile: true,
  });
  assert.ok(!read(dir, "scenes/main.tscn").includes("Vector2(1, 2)"), "dryRun 不得落盘");

  // 文件里原本没有该属性:before=null 且 inFile=false(不猜引擎默认值)
  const added = ok(await host.callTool("scene_update_node_property", {
    path: p, nodePath: "Player", key: "z_index", value: "3",
  }));
  assert.deepEqual(added["change"], {
    property: "z_index", before: null, after: { raw: "3", value: 3 }, inFile: false,
  });

  // 认不得的字面量:只给 raw(不含 value 字段)
  const opaque = ok(await host.callTool("scene_update_node_property", {
    path: p, nodePath: "Player", key: "transform", value: "Transform2D(1, 0, 0, 1, 0, 0)",
  }));
  const change = opaque["change"] as { before: unknown; after: Record<string, unknown> };
  assert.deepEqual(change.before, null);
  assert.deepEqual(change.after, { raw: "Transform2D(1, 0, 0, 1, 0, 0)" });
  assert.equal("value" in change.after, false);
});

test("scene_add_node: created 回报新节点与写入的属性(静态值)", async (t) => {
  const { host } = makeHost(t);
  const r = ok(await host.callTool("scene_add_node", {
    path: "res://scenes/main.tscn",
    parentPath: "Player",
    nodeType: "CharacterBody2D",
    nodeName: "Enemy",
    properties: [
      { name: "position", value: "Vector2(5, 6)" },
      { name: "visible", value: "false" },
      { name: "shape", value: 'SubResource("1_x")' },
    ],
  }));
  assert.deepEqual(r["created"], {
    nodePath: "Player/Enemy",
    type: "CharacterBody2D",
    parent: "Player",
    properties: {
      position: { raw: "Vector2(5, 6)", value: { type: "Vector2", v: [5, 6] } },
      visible: { raw: "false", value: false },
      shape: { raw: 'SubResource("1_x")' }, // 认不得 → 只有 raw
    },
  });

  // 不写属性时 properties 为空对象;parent 为根的直接子节点时是 "."
  const bare = ok(await host.callTool("scene_add_node", {
    path: "res://scenes/main.tscn", parentPath: ".", nodeType: "Node2D", nodeName: "Bare",
  }));
  assert.deepEqual(bare["created"], { nodePath: "Bare", type: "Node2D", parent: ".", properties: {} });
});

test("scene_remove_node: removed 回报整棵被删子树(文件顺序)", async (t) => {
  const { host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  const one = ok(await host.callTool("scene_remove_node", { path: p, nodePath: "Player/Sprite", confirm: true }));
  assert.deepEqual(one["removed"], { nodePaths: ["Player/Sprite"], count: 1 });

  ok(await host.callTool("scene_add_node", { path: p, parentPath: "Player", nodeType: "Node2D", nodeName: "Holder" }));
  ok(await host.callTool("scene_add_node", { path: p, parentPath: "Player/Holder", nodeType: "Marker2D", nodeName: "Leaf" }));
  const sub = ok(await host.callTool("scene_remove_node", { path: p, nodePath: "Player", confirm: true }));
  assert.deepEqual(sub["removed"], {
    nodePaths: ["Player", "Player/Holder", "Player/Holder/Leaf"],
    count: 3,
  });
});

test("scene_reparent_node: moved 回报 from/to/count(幂等时为 0)", async (t) => {
  const { host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  ok(await host.callTool("scene_add_node", { path: p, parentPath: ".", nodeType: "Node2D", nodeName: "Holder" }));
  ok(await host.callTool("scene_add_node", { path: p, parentPath: "Holder", nodeType: "Marker2D", nodeName: "Leaf" }));

  const r = ok(await host.callTool("scene_reparent_node", { path: p, nodePath: "Holder", newParentPath: "Player" }));
  assert.deepEqual(r["moved"], { from: "Holder", to: "Player/Holder", count: 2 });

  const again = ok(await host.callTool("scene_reparent_node", { path: p, nodePath: "Player/Holder", newParentPath: "Player" }));
  assert.equal(again["changed"], false);
  assert.deepEqual(again["moved"], { from: "Player/Holder", to: "Player/Holder", count: 0 });
});

test("scene_instantiate_scene: instantiated 回报节点路径与来源场景", async (t) => {
  const { host } = makeHost(t);
  const p = "res://scenes/main.tscn";
  const r = ok(await host.callTool("scene_instantiate_scene", {
    path: p, parentPath: "Player", instanceScenePath: "res://scenes/child.tscn",
  }));
  assert.deepEqual(r["instantiated"], { nodePath: "Player/Child", scene: "res://scenes/child.tscn" });

  const named = ok(await host.callTool("scene_instantiate_scene", {
    path: p, parentPath: ".", instanceScenePath: "res://scenes/child.tscn", nodeName: "Second",
  }));
  assert.deepEqual(named["instantiated"], { nodePath: "Second", scene: "res://scenes/child.tscn" });
});

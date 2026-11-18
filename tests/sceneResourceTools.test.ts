// Stage 2 / T2.4:scene_* 与 resource_* 工具经 ToolHost 的端到端(路径解析 → 读 → Service → 写)。
// 用临时项目目录(project.godot + 内联 .tscn/.tres)验证读/改/删/错误信封,不依赖真实 Godot。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";

const quiet = createLogger("error", () => {});

const SCENE = `[gd_scene format=3]

[node name="Root" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]
position = Vector2(0, 0)

[node name="Sprite" type="Sprite2D" parent="Player"]
`;

const TRES = `[gd_resource type="StandardMaterial3D" load_steps=2 format=3]

[ext_resource type="Script" path="res://mat.gd" id="1_mat"]

[resource]
albedo_color = Color(1, 0, 0, 1)
roughness = 0.5
`;

interface Host { dir: string; host: ToolHost<AppContext> }

/** 建临时项目 + ToolHost(全工具注册)。resolver cwd 可注入(测试 projectPath 覆盖)。 */
function makeHost(t: { after: (fn: () => void) => void }, cwd?: string): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "materials"), { recursive: true });
  fs.writeFileSync(path.join(dir, "project.godot"), "config_version=5\n");
  fs.writeFileSync(path.join(dir, "scenes", "main.tscn"), SCENE);
  fs.writeFileSync(path.join(dir, "materials", "mat.tres"), TRES);
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: cwd ?? dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: unknown }).data as Record<string, unknown>;
}

function err(r: ToolResult): { code: string; message: string; details?: Record<string, unknown> } {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }).error;
}

// ---------- scene ----------

test("scene_get_tree: 读取结构化节点树 + 返回 hash/resPath", async (t) => {
  const { host } = makeHost(t);
  const data = ok(await host.callTool("scene_get_tree", { path: "res://scenes/main.tscn" }));
  assert.equal(data["resPath"], "res://scenes/main.tscn");
  assert.equal(typeof data["hash"], "string");
  assert.equal((data["hash"] as string).length, 64);
  const nodes = (data["tree"] as { nodes: Array<{ path: string; type?: string }> }).nodes;
  assert.deepEqual(nodes.map((n) => n.path), [".", "Player", "Player/Sprite"]);
  assert.equal(nodes[1]?.type, "CharacterBody2D");
});

test("scene_update_node_property: dryRun 不落盘;真实写单行;幂等第二次 changed=false", async (t) => {
  const { dir, host } = makeHost(t);
  const scene = path.join(dir, "scenes", "main.tscn");

  const dry = ok(await host.callTool("scene_update_node_property", {
    path: "res://scenes/main.tscn", nodePath: "Player", key: "position", value: "Vector2(1, 2)", dryRun: true,
  }));
  assert.equal(dry["changed"], true);
  assert.match(dry["diff"] as string, /Vector2\(1, 2\)/);
  assert.equal(fs.readFileSync(scene, "utf8"), SCENE); // dryRun 不落盘

  const wrote = ok(await host.callTool("scene_update_node_property", {
    path: "res://scenes/main.tscn", nodePath: "Player", key: "position", value: "Vector2(1, 2)",
  }));
  assert.equal(wrote["changed"], true);
  const onDisk = fs.readFileSync(scene, "utf8");
  assert.ok(onDisk.includes("position = Vector2(1, 2)"));
  assert.ok(onDisk.includes('[node name="Root" type="Node2D"]'));

  const again = ok(await host.callTool("scene_update_node_property", {
    path: "res://scenes/main.tscn", nodePath: "Player", key: "position", value: "Vector2(1, 2)",
  }));
  assert.equal(again["changed"], false);
});

test("scene_update_node_property: expectedHash 不匹配抛 FILE_CHANGED 且不覆盖", async (t) => {
  const { dir, host } = makeHost(t);
  const scene = path.join(dir, "scenes", "main.tscn");
  const read = ok(await host.callTool("scene_get_tree", { path: "res://scenes/main.tscn" }));

  fs.writeFileSync(scene, SCENE.replace("Vector2(0, 0)", "Vector2(9, 9)")); // 并发篡改
  const r = await host.callTool("scene_update_node_property", {
    path: "res://scenes/main.tscn", nodePath: "Player", key: "position", value: "Vector2(1, 2)", expectedHash: read["hash"],
  });
  assert.equal(err(r).code, "FILE_CHANGED");
  assert.ok(fs.readFileSync(scene, "utf8").includes("Vector2(9, 9)")); // 未被覆盖
});

test("scene_remove_node: 删除子树,其余字节不变", async (t) => {
  const { dir, host } = makeHost(t);
  const r = ok(await host.callTool("scene_remove_node", { path: "res://scenes/main.tscn", nodePath: "Player", confirm: true }));
  assert.equal(r["changed"], true);
  const onDisk = fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8");
  assert.ok(!onDisk.includes('[node name="Player"'));
  assert.ok(!onDisk.includes('[node name="Sprite"'));
  assert.ok(onDisk.includes('[node name="Root" type="Node2D"]'));
});

test("scene 工具:文件不存在 / 路径穿越 / 未知参数 / 节点不存在 分别报对应错误", async (t) => {
  const { host } = makeHost(t);
  assert.equal(err(await host.callTool("scene_get_tree", { path: "res://nope.tscn" })).code, "FILE_NOT_FOUND");
  assert.equal(err(await host.callTool("scene_get_tree", { path: "res://../../etc/passwd" })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("scene_get_tree", { path: "res://scenes/main.tscn", bogus: 1 })).code, "INVALID_ARGUMENT");
  assert.equal(
    err(await host.callTool("scene_update_node_property", { path: "res://scenes/main.tscn", nodePath: "Ghost", key: "x", value: "1" })).code,
    "INVALID_ARGUMENT",
  );
});

// ---------- resource ----------

test("resource_get_info: 提取头部与外部依赖", async (t) => {
  const { host } = makeHost(t);
  const data = ok(await host.callTool("resource_get_info", { path: "res://materials/mat.tres" }));
  const info = data["info"] as { type?: string; externalResources: Array<{ id: string; type: string; path: string }> };
  assert.equal(info.type, "StandardMaterial3D");
  assert.deepEqual(info.externalResources, [{ id: "1_mat", type: "Script", path: "res://mat.gd" }]);
});

test("resource_update_property: 修改 [resource] 属性", async (t) => {
  const { dir, host } = makeHost(t);
  const r = ok(await host.callTool("resource_update_property", {
    path: "res://materials/mat.tres", sectionHeader: "resource", key: "roughness", value: "0.75",
  }));
  assert.equal(r["changed"], true);
  assert.ok(fs.readFileSync(path.join(dir, "materials", "mat.tres"), "utf8").includes("roughness = 0.75"));
});

test("resource_update_property: change 回报文件静态前后值(含新增属性 before=null)", async (t) => {
  const { host } = makeHost(t);
  const wrote = ok(await host.callTool("resource_update_property", {
    path: "res://materials/mat.tres", sectionHeader: "resource", key: "roughness", value: "0.75",
  }));
  assert.deepEqual(wrote["change"], {
    property: "roughness",
    before: { raw: "0.5", value: 0.5 },
    after: { raw: "0.75", value: 0.75 },
    inFile: true,
  });

  // 文件里已存在的属性:before 取文件中原来的写法
  const existing = ok(await host.callTool("resource_update_property", {
    path: "res://materials/mat.tres", sectionHeader: "resource", key: "albedo_color", value: "Color(0, 1, 0, 1)",
  }));
  assert.deepEqual(existing["change"], {
    property: "albedo_color",
    before: { raw: "Color(1, 0, 0, 1)", value: { type: "Color", v: [1, 0, 0, 1] } },
    after: { raw: "Color(0, 1, 0, 1)", value: { type: "Color", v: [0, 1, 0, 1] } },
    inFile: true,
  });

  const fresh = ok(await host.callTool("resource_update_property", {
    path: "res://materials/mat.tres", sectionHeader: "resource", key: "metallic_specular", value: "0.25",
  }));
  assert.deepEqual(fresh["change"], {
    property: "metallic_specular", before: null, after: { raw: "0.25", value: 0.25 }, inFile: false,
  });
});

test("resource_add_or_update_external: 新增 ext_resource 条目", async (t) => {
  const { dir, host } = makeHost(t);
  const r = ok(await host.callTool("resource_add_or_update_external", {
    path: "res://materials/mat.tres", resource: { id: "2_tex", type: "Texture2D", path: "res://icon.svg" },
  }));
  assert.equal(r["changed"], true);
  const onDisk = fs.readFileSync(path.join(dir, "materials", "mat.tres"), "utf8");
  assert.ok(onDisk.includes('[ext_resource type="Texture2D" path="res://icon.svg" id="2_tex"]'));
  assert.ok(onDisk.includes('id="1_mat"')); // 既有条目保留
});

// ---------- projectPath 覆盖 ----------

test("projectPath 参数可覆盖项目根(cwd 无 project.godot 时)", async (t) => {
  const { dir, host } = makeHost(t, os.tmpdir());
  const data = ok(await host.callTool("scene_get_tree", { path: "res://scenes/main.tscn", projectPath: dir }));
  assert.deepEqual((data["tree"] as { nodes: Array<{ path: string }> }).nodes.map((n) => n.path), [".", "Player", "Player/Sprite"]);
});

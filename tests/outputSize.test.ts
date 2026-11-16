// P2-A:降低返回体积,同时保持旧行为可用。
//   - scene_get_tree brief=true:同一棵树只出现一次(嵌套),不返回扁平 nodes;
//   - asset_list:不传 limit/offset 时仍是完整列表;分页/过滤只扫描一次项目。
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

const HERE = import.meta.dirname!;
const FIXTURE = path.join(HERE, "..", "..", "tests", "fixture_project");
const PNG = fs.readFileSync(path.join(HERE, "..", "..", "tests", "fixtures", "sample_project", "icon_fixture.png"));
const quiet = createLogger("error", () => {});

function hostFor(t: { after: (fn: () => void) => void }, dir: string): ToolHost<AppContext> {
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  return new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet);
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: Record<string, unknown> }).data;
}

function makeAssetProject(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-p2a-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="P2A"\n');
  fs.mkdirSync(path.join(dir, "textures"), { recursive: true });
  for (let i = 0; i < 105; i += 1) {
    fs.writeFileSync(path.join(dir, "textures", `tex_${String(i).padStart(3, "0")}.png`), PNG);
  }
  fs.mkdirSync(path.join(dir, "scenes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scenes", "main.tscn"), '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n');
  fs.writeFileSync(path.join(dir, "data.tres"), '[gd_resource type="Resource" format=3]\n\n[resource]\n');
  return dir;
}

test("asset_list default stays the full legacy list", async (t) => {
  const dir = makeAssetProject(t);
  const data = ok(await hostFor(t, dir).callTool("asset_list", {}));
  assert.equal(data["total"], 107);
  assert.equal(data["returned"], 107);
  assert.equal(data["limit"], null);
  assert.equal(data["nextOffset"], null);
  assert.equal((data["assets"] as unknown[]).length, 107);
});

test("asset_list paginates with total/returned/nextOffset", async (t) => {
  const dir = makeAssetProject(t);
  const host = hostFor(t, dir);

  const first = ok(await host.callTool("asset_list", { limit: 10, offset: 0 }));
  assert.equal(first["total"], 107);
  assert.equal(first["returned"], 10);
  assert.equal(first["offset"], 0);
  assert.equal(first["limit"], 10);
  assert.equal(first["nextOffset"], 10);
  assert.equal(first["hasMore"], true);

  const last = ok(await host.callTool("asset_list", { limit: 10, offset: 100 }));
  assert.equal(last["returned"], 7);
  assert.equal(last["nextOffset"], null);
  assert.equal(last["hasMore"], false);

  // offset 单独出现也意味着分页(默认页大小 100)。
  const offsetOnly = ok(await host.callTool("asset_list", { offset: 100 }));
  assert.equal(offsetOnly["returned"], 7);
  assert.equal(offsetOnly["limit"], 100);
});

test("asset_list filters by extension, path substring and import status", async (t) => {
  const dir = makeAssetProject(t);
  fs.mkdirSync(path.join(dir, ".godot", "imported"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".godot", "imported", "tex_000.png-abc.ctex"), "ctex");
  fs.writeFileSync(path.join(dir, "textures", "tex_000.png.import"), [
    "[remap]", "", 'importer="texture"', 'type="CompressedTexture2D"',
    'path="res://.godot/imported/tex_000.png-abc.ctex"', "",
    "[deps]", "", 'source_file="res://textures/tex_000.png"',
    'dest_files=["res://.godot/imported/tex_000.png-abc.ctex"]', "",
  ].join("\n"));
  const host = hostFor(t, dir);

  const scenes = ok(await host.callTool("asset_list", { extension: "tscn" }));
  assert.equal(scenes["total"], 1);
  assert.equal((scenes["assets"] as Array<Record<string, unknown>>)[0]!["path"], "res://scenes/main.tscn");

  const dotPng = ok(await host.callTool("asset_list", { extension: ".PNG" }));
  assert.equal(dotPng["total"], 105);

  const filtered = ok(await host.callTool("asset_list", { filter: "tex_09" }));
  assert.equal(filtered["total"], 10);

  const imported = ok(await host.callTool("asset_list", { importStatus: "imported" }));
  assert.equal(imported["total"], 1);
  const artifactMissing = ok(await host.callTool("asset_list", { importStatus: "artifact_missing" }));
  assert.equal(artifactMissing["total"], 0, "the other PNGs have no .import at all");
  const notImported = ok(await host.callTool("asset_list", { importStatus: "not_imported" }));
  assert.equal(notImported["total"], 104);

  // 组合过滤 + 分页
  const page = ok(await host.callTool("asset_list", { extension: "png", limit: 5, offset: 100 }));
  assert.equal(page["total"], 105);
  assert.equal(page["returned"], 5);
  assert.equal(page["nextOffset"], null);
});

test("scene_get_tree brief returns the tree once and keeps connections", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-p2a-scene-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const host = hostFor(t, dir);

  const full = ok(await host.callTool("scene_get_tree", { path: "res://scenes/main.tscn" }));
  const fullTree = full["tree"] as { nodes: unknown[]; root: unknown; connections: unknown[] };
  assert.ok(Array.isArray(fullTree.nodes), "full mode keeps the flat nodes array");

  const brief = ok(await host.callTool("scene_get_tree", { path: "res://scenes/main.tscn", brief: true }));
  assert.equal(brief["brief"], true);
  const briefTree = brief["tree"] as Record<string, unknown>;
  assert.equal("nodes" in briefTree, false, "brief must not repeat the tree as a flat array");
  assert.equal(briefTree["nodeCount"], fullTree.nodes.length);
  assert.equal((briefTree["connections"] as unknown[]).length, fullTree.connections.length);
  assert.equal((briefTree["root"] as Record<string, unknown>)["name"], "Root");
  assert.ok(Array.isArray((briefTree["root"] as Record<string, unknown>)["children"]));

  const fullBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
  const briefBytes = Buffer.byteLength(JSON.stringify(brief), "utf8");
  assert.ok(briefBytes < fullBytes, `brief (${briefBytes}B) must be smaller than full (${fullBytes}B)`);
});

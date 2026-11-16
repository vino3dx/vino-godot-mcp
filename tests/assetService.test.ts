// P0-A: asset_list.imported 必须来自真实导入产物,不能只看 .import 文件是否存在。
// 夹具同时覆盖:正常导入、产物缺失、空产物、无 .import、无效记录、非导入类型、
// 不同导入器的产物扩展名(.fontdata,证明没有假定 .ctex)、source_file 错配、越界产物路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssetService } from "../src/services/assetService.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { createLogger } from "../src/core/logger.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext, type AppContext } from "../src/services/context.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";

const HERE = import.meta.dirname!;
const PNG = fs.readFileSync(path.join(HERE, "..", "..", "tests", "fixtures", "sample_project", "icon_fixture.png"));
const quiet = createLogger("error", () => {});

interface Fixture { dir: string; assets: AssetService }

function makeProject(t: { after: (fn: () => void) => void }): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-asset-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="AssetFixture"\n');
  return { dir, assets: new AssetService(new ProjectResolver({ cwd: dir })) };
}

function write(dir: string, rel: string, data: string | Buffer): string {
  const abs = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return abs;
}

/** 写一个与真实 Godot .import 同构的记录(字段顺序不敏感)。 */
function writeImport(
  dir: string,
  sourceRel: string,
  options: { dest: string[]; remapPath?: string; sourceFile?: string; importer?: string; type?: string; raw?: string },
): void {
  const rel = sourceRel.replace(/^res:\/\//, "");
  const body = options.raw ?? [
    "[remap]",
    "",
    `importer=${JSON.stringify(options.importer ?? "texture")}`,
    `type=${JSON.stringify(options.type ?? "CompressedTexture2D")}`,
    ...(options.remapPath === undefined ? [] : [`path=${JSON.stringify(options.remapPath)}`]),
    "metadata={",
    '"vram_texture": false',
    "}",
    "",
    "[deps]",
    "",
    `source_file=${JSON.stringify(options.sourceFile ?? `res://${rel}`)}`,
    `dest_files=[${options.dest.map((d) => JSON.stringify(d)).join(", ")}]`,
    "",
    "[params]",
    "",
    "compress/mode=0",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, ...`${rel}.import`.split("/")), body);
}

function find(fixture: Fixture, resPath: string) {
  return fixture.assets.getInfo(fixture.dir, resPath);
}

test("imported=true only when every dest_files artifact exists", (t) => {
  const f = makeProject(t);
  write(f.dir, "sprites/ok.png", PNG);
  write(f.dir, ".godot/imported/ok.png-abc.ctex", Buffer.from("ctex-bytes"));
  writeImport(f.dir, "sprites/ok.png", { dest: ["res://.godot/imported/ok.png-abc.ctex"] });

  const info = find(f, "res://sprites/ok.png");
  assert.equal(info.importStatus, "imported");
  assert.equal(info.imported, true);
  assert.deepEqual(info.importDetails.artifacts, ["res://.godot/imported/ok.png-abc.ctex"]);
  assert.equal(info.width, 4);
  assert.equal(info.height, 4);
});

test("an .import record without its .ctex is artifact_missing, not imported", (t) => {
  const f = makeProject(t);
  write(f.dir, "sprites/missing.png", PNG);
  writeImport(f.dir, "sprites/missing.png", { dest: ["res://.godot/imported/missing.png-abc.ctex"] });

  const info = find(f, "res://sprites/missing.png");
  assert.equal(info.importStatus, "artifact_missing");
  assert.equal(info.imported, false, "the legacy boolean must not claim success");
  assert.deepEqual(info.importDetails.missingArtifacts, ["res://.godot/imported/missing.png-abc.ctex"]);
});

test("a zero-byte artifact is treated as missing", (t) => {
  const f = makeProject(t);
  write(f.dir, "sprites/empty.png", PNG);
  write(f.dir, ".godot/imported/empty.png-abc.ctex", "");
  writeImport(f.dir, "sprites/empty.png", { dest: ["res://.godot/imported/empty.png-abc.ctex"] });

  assert.equal(find(f, "res://sprites/empty.png").importStatus, "artifact_missing");
});

test("no .import is not_imported", (t) => {
  const f = makeProject(t);
  write(f.dir, "sprites/fresh.png", PNG);
  const info = find(f, "res://sprites/fresh.png");
  assert.equal(info.importStatus, "not_imported");
  assert.equal(info.imported, false);
});

test("an unparseable or incomplete .import is invalid_import", (t) => {
  const f = makeProject(t);
  write(f.dir, "a.png", PNG);
  writeImport(f.dir, "a.png", { dest: [], raw: '[remap\nimporter="texture"\n' });
  assert.equal(find(f, "res://a.png").importDetails.reason, "import_parse_error");

  write(f.dir, "b.png", PNG);
  writeImport(f.dir, "b.png", { dest: [], raw: '[deps]\n\nsource_file="res://b.png"\n' });
  assert.equal(find(f, "res://b.png").importStatus, "invalid_import");
  assert.equal(find(f, "res://b.png").importDetails.reason, "missing_importer_or_type");

  write(f.dir, "c.png", PNG);
  writeImport(f.dir, "c.png", { dest: [] });
  assert.equal(find(f, "res://c.png").importDetails.reason, "empty_dest_files");
});

test("a record whose source_file points elsewhere is invalid_import", (t) => {
  const f = makeProject(t);
  write(f.dir, "sprites/renamed.png", PNG);
  write(f.dir, ".godot/imported/renamed.png-abc.ctex", Buffer.from("x"));
  writeImport(f.dir, "sprites/renamed.png", {
    dest: ["res://.godot/imported/renamed.png-abc.ctex"],
    sourceFile: "res://sprites/old_name.png",
  });
  const info = find(f, "res://sprites/renamed.png");
  assert.equal(info.importStatus, "invalid_import");
  assert.equal(info.importDetails.reason, "source_mismatch");
});

test("a dest path outside the project invalidates the record", (t) => {
  const f = makeProject(t);
  write(f.dir, "sprites/escape.png", PNG);
  writeImport(f.dir, "sprites/escape.png", { dest: ["res://../escape.ctex"] });
  const info = find(f, "res://sprites/escape.png");
  assert.equal(info.importStatus, "invalid_import");
  assert.equal(info.importDetails.reason, "dest_outside_project");
});

test("fonts use their own product extension (no .ctex assumption)", (t) => {
  const f = makeProject(t);
  write(f.dir, "fonts/ui.ttf", Buffer.from([0, 1, 0, 0]));
  write(f.dir, ".godot/imported/ui.ttf-abc.fontdata", Buffer.from("fontdata"));
  writeImport(f.dir, "fonts/ui.ttf", {
    importer: "font_data_dynamic", type: "FontFile",
    dest: ["res://.godot/imported/ui.ttf-abc.fontdata"],
  });
  const info = find(f, "res://fonts/ui.ttf");
  assert.equal(info.kind, "font");
  assert.equal(info.importStatus, "imported");
});

test(".tscn and .tres are not_applicable and never claimed imported", (t) => {
  const f = makeProject(t);
  write(f.dir, "main.tscn", '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n');
  write(f.dir, "data.tres", '[gd_resource type="Resource" format=3]\n\n[resource]\n');
  for (const p of ["res://main.tscn", "res://data.tres"]) {
    const info = find(f, p);
    assert.equal(info.importStatus, "not_applicable");
    assert.equal(info.imported, false);
  }
});

test("asset_list exposes verified statuses while keeping the legacy imported field", async (t) => {
  const f = makeProject(t);
  write(f.dir, "ok.png", PNG);
  write(f.dir, ".godot/imported/ok.png-abc.ctex", Buffer.from("x"));
  writeImport(f.dir, "ok.png", { dest: ["res://.godot/imported/ok.png-abc.ctex"] });
  write(f.dir, "missing.png", PNG);
  writeImport(f.dir, "missing.png", { dest: ["res://.godot/imported/missing.png-abc.ctex"] });
  write(f.dir, "fresh.png", PNG);

  const list = f.assets.list(f.dir);
  const byPath = new Map(list.map((a) => [a.path, a]));
  assert.equal(byPath.get("res://ok.png")?.importStatus, "imported");
  assert.equal(byPath.get("res://ok.png")?.imported, true);
  assert.equal(byPath.get("res://missing.png")?.importStatus, "artifact_missing");
  assert.equal(byPath.get("res://missing.png")?.imported, false);
  assert.equal(byPath.get("res://fresh.png")?.importStatus, "not_imported");
  // 列表对正常状态省略重复的 importDetails,异常状态保留依据。
  const host = new ToolHost(
    new ToolRegistry<AppContext>().registerAll(allTools),
    createAppContext(quiet, new ProjectResolver({ cwd: f.dir })),
    quiet,
  );
  const listedResult = await host.callTool("asset_list", {});
  assert.equal(listedResult.ok, true);
  const listedData = (listedResult as { ok: true; data: Record<string, unknown> }).data;
  const listed = (listedData["assets"] as Array<Record<string, unknown>>).find((a) => a["path"] === "res://missing.png");
  assert.ok(listed?.["importDetails"], "problem entries keep their evidence");
});

test("the repository's engine-generated sample is reported as artifact_missing", () => {
  const sample = path.join(HERE, "..", "..", "tests", "fixtures", "sample_project");
  const assets = new AssetService(new ProjectResolver({ cwd: sample }));
  const icon = assets.getInfo(sample, "res://icon_fixture.png");
  assert.equal(icon.importStatus, "artifact_missing", "the .ctex is not checked in; imported must not be true");
  assert.equal(icon.imported, false);
});

test("asset_get_info tool returns importStatus together with recommended nodes", async (t) => {
  const f = makeProject(t);
  write(f.dir, "ok.png", PNG);
  write(f.dir, ".godot/imported/ok.png-abc.ctex", Buffer.from("x"));
  writeImport(f.dir, "ok.png", { dest: ["res://.godot/imported/ok.png-abc.ctex"] });
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: f.dir }));
  const host = new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet);
  const r = await host.callTool("asset_get_info", { path: "res://ok.png" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const data = (r as { ok: true; data: Record<string, unknown> }).data;
  assert.equal(data["importStatus"], "imported");
  assert.deepEqual(data["recommendedNodes"], ["TextureRect", "Sprite2D", "NinePatchRect"]);
  const typed = r as ToolResult;
  assert.equal(typed.ok, true);
});

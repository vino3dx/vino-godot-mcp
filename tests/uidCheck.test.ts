// P1-B:UID/Path 一致性检查。夹具覆盖全部状态:
// ok / uid_missing / path_missing / uid_unresolved / uid_mismatch / unknown(格式错误、重复 UID)。
// 同时验证 UID 来源:.uid sidecar、.import [remap] uid、.tscn/.tres 段头 uid。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UidCheckService } from "../src/services/uidService.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { createLogger } from "../src/core/logger.js";
import { createAppContext, type AppContext } from "../src/services/context.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { allTools } from "../src/tools/index.js";
import { sha256Hex } from "../src/core/filesystem/safeWrite.js";

const quiet = createLogger("error", () => {});

const REFS = [
  '[gd_scene format=3 uid="uid://refs1"]',
  "",
  '[ext_resource type="Script" uid="uid://player1" path="res://player.gd" id="ok_script"]',
  '[ext_resource type="Texture2D" uid="uid://icon1" path="res://icon.png" id="ok_texture"]',
  '[ext_resource type="PackedScene" uid="uid://scene1" path="res://main.tscn" id="ok_scene"]',
  '[ext_resource type="Resource" uid="uid://tres1" path="res://data.tres" id="ok_tres"]',
  '[ext_resource type="Script" uid="uid://other1" path="res://player.gd" id="mismatch"]',
  '[ext_resource type="Script" uid="uid://missing1" path="res://player.gd" id="unresolved"]',
  '[ext_resource type="Script" path="res://player.gd" id="no_uid"]',
  '[ext_resource type="Script" uid="uid://player1" path="res://nope.gd" id="missing_path"]',
  '[ext_resource type="Script" uid="not-a-uid" path="res://player.gd" id="malformed"]',
  '[ext_resource type="Script" uid="uid://player1" id="no_path"]',
  '[ext_resource type="Script" uid="uid://dup1" path="res://dup1.gd" id="ambiguous"]',
  "",
  '[node name="Root" type="Node"]',
  "",
].join("\n");

function fixture(t: { after: (fn: () => void) => void }): { dir: string; uids: UidCheckService } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-uid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel: string, data: string): void => {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  };
  write("project.godot", 'config_version=5\n\n[application]\n\nconfig/name="UidFixture"\n');
  write("player.gd", "extends Node\n");
  write("player.gd.uid", "uid://player1\n");
  write("other.gd", "extends Node\n");
  write("other.gd.uid", "uid://other1\n");
  write("dup1.gd", "extends Node\n");
  write("dup1.gd.uid", "uid://dup1\n");
  write("dup2.gd", "extends Node\n");
  write("dup2.gd.uid", "uid://dup1\n");
  write("icon.png", "not-a-real-png");
  write("icon.png.import", '[remap]\n\nimporter="texture"\ntype="CompressedTexture2D"\nuid="uid://icon1"\npath="res://.godot/imported/icon.png-abc.ctex"\n\n[deps]\n\nsource_file="res://icon.png"\ndest_files=["res://.godot/imported/icon.png-abc.ctex"]\n');
  write("main.tscn", '[gd_scene format=3 uid="uid://scene1"]\n\n[node name="Main" type="Node"]\n');
  write("data.tres", '[gd_resource type="Resource" format=3 uid="uid://tres1"]\n\n[resource]\n');
  write("refs.tscn", REFS);
  return { dir, uids: new UidCheckService(new ProjectResolver({ cwd: dir })) };
}

function byId(report: ReturnType<UidCheckService["check"]>, id: string) {
  const issue = report.issues.find((i) => i.resourceId === id);
  assert.ok(issue, `issue ${id} missing: ${JSON.stringify(report.issues)}`);
  return issue;
}

test("classifies every uid/path state and never writes", (t) => {
  const { dir, uids } = fixture(t);
  const before = sha256Hex(fs.readFileSync(path.join(dir, "refs.tscn"), "utf8"));
  const report = uids.check(dir);

  assert.equal(report.references, 11);
  assert.equal(report.ok, 4);
  assert.deepEqual(report.summary, {
    uid_missing: 1, path_missing: 2, uid_unresolved: 1, uid_mismatch: 1, unknown: 2,
  });

  assert.equal(byId(report, "mismatch").status, "uid_mismatch");
  assert.equal(byId(report, "mismatch").resolvedPath, "res://other.gd");
  assert.equal(byId(report, "unresolved").status, "uid_unresolved");
  assert.equal(byId(report, "no_uid").status, "uid_missing");
  assert.equal(byId(report, "missing_path").status, "path_missing");
  assert.equal(byId(report, "malformed").status, "unknown");
  assert.equal(byId(report, "no_path").status, "path_missing");
  assert.equal(byId(report, "ambiguous").status, "unknown");

  assert.deepEqual(report.duplicateUids, [{ uid: "uid://dup1", paths: ["res://dup1.gd", "res://dup2.gd"] }]);

  // 只检查不修复:文件逐字节不变。
  assert.equal(sha256Hex(fs.readFileSync(path.join(dir, "refs.tscn"), "utf8")), before);
});

test("scanning a single file or a subdirectory limits the scope", (t) => {
  const { dir, uids } = fixture(t);
  const single = uids.check(dir, "res://refs.tscn");
  assert.equal(single.filesScanned, 1);
  assert.equal(single.references, 11);

  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sub", "clean.tscn"), '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n');
  const sub = uids.check(dir, "res://sub");
  assert.equal(sub.filesScanned, 1);
  assert.equal(sub.references, 0);
  assert.deepEqual(sub.issues, []);
});

test("resource_check_uid tool returns the report and leaves files untouched", async (t) => {
  const { dir } = fixture(t);
  const before = sha256Hex(fs.readFileSync(path.join(dir, "refs.tscn"), "utf8"));
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  const host = new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet);
  const r = await host.callTool("resource_check_uid", { path: "res://refs.tscn" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const data = (r as { ok: true; data: Record<string, unknown> }).data;
  assert.equal(data["references"], 11);
  assert.equal((data["summary"] as Record<string, number>)["uid_mismatch"], 1);
  assert.equal(sha256Hex(fs.readFileSync(path.join(dir, "refs.tscn"), "utf8")), before);
});

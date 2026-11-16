// P1-C:批量文件漂移检查。覆盖未变化 / 已修改 / 已删除 / 不可读(目录)，
// 以及"一个文件不存在不会中断整批"和与 scene_get_tree 的 expectedHash 互操作。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { sha256Hex } from "../src/core/filesystem/safeWrite.js";
import { createAppContext, type AppContext } from "../src/services/context.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { allTools } from "../src/tools/index.js";

const quiet = createLogger("error", () => {});

interface Fixture { dir: string; host: ToolHost<AppContext> }

function makeProject(t: { after: (fn: () => void) => void }): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-changes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="ChangeFixture"\n');
  fs.writeFileSync(path.join(dir, "a.gd"), "extends Node\n");
  fs.writeFileSync(path.join(dir, "b.gd"), "extends Node\n");
  fs.writeFileSync(path.join(dir, "c.gd"), "extends Node\n");
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function hashFile(dir: string, rel: string): string {
  return sha256Hex(fs.readFileSync(path.join(dir, ...rel.split("/"))));
}

function data(r: Awaited<ReturnType<ToolHost<AppContext>["callTool"]>>): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: Record<string, unknown> }).data;
}

test("reports unchanged / modified / missing without aborting the batch", async (t) => {
  const { dir, host } = makeProject(t);
  const a = hashFile(dir, "a.gd");
  const b = hashFile(dir, "b.gd");
  const c = hashFile(dir, "c.gd");
  fs.writeFileSync(path.join(dir, "b.gd"), "extends Node\n# edited by user\n");
  fs.rmSync(path.join(dir, "c.gd"));

  const report = data(await host.callTool("project_check_changes", {
    files: [
      { path: "res://a.gd", expectedHash: a },
      { path: "res://b.gd", expectedHash: b },
      { path: "res://c.gd", expectedHash: c },
    ],
  }));

  assert.equal(report["total"], 3);
  assert.deepEqual(report["unchanged"], ["res://a.gd"]);
  assert.deepEqual(report["modified"], ["res://b.gd"]);
  assert.deepEqual(report["missing"], ["res://c.gd"]);
  assert.deepEqual(report["unreadable"], []);

  const results = report["results"] as Array<Record<string, unknown>>;
  assert.deepEqual(results.map((r) => r["path"]), ["res://a.gd", "res://b.gd", "res://c.gd"], "input order is preserved");
  assert.equal(results[0]!["status"], "unchanged");
  assert.equal(results[1]!["status"], "modified");
  assert.notEqual(results[1]!["currentHash"], b);
  assert.equal(results[2]!["status"], "missing");
  assert.equal(results[2]!["currentHash"], undefined);

  // 只读:检查前后文件内容未变。
  assert.equal(fs.readFileSync(path.join(dir, "b.gd"), "utf8"), "extends Node\n# edited by user\n");
  assert.equal(hashFile(dir, "a.gd"), a);
});

test("a missing file never makes the whole batch fail", async (t) => {
  const { dir, host } = makeProject(t);
  const report = data(await host.callTool("project_check_changes", {
    files: [
      { path: "res://does_not_exist.gd", expectedHash: "deadbeef" },
      { path: "res://a.gd", expectedHash: hashFile(dir, "a.gd") },
    ],
  }));
  assert.deepEqual(report["missing"], ["res://does_not_exist.gd"]);
  assert.deepEqual(report["unchanged"], ["res://a.gd"]);
});

test("a directory entry is reported as unreadable instead of aborting", async (t) => {
  const { dir, host } = makeProject(t);
  fs.mkdirSync(path.join(dir, "folder"));
  const report = data(await host.callTool("project_check_changes", {
    files: [{ path: "res://folder", expectedHash: "deadbeef" }],
  }));
  assert.deepEqual(report["unreadable"], ["res://folder"]);
  const results = report["results"] as Array<Record<string, unknown>>;
  assert.equal(results[0]!["status"], "error");
  assert.equal(typeof results[0]!["error"], "string");
});

test("duplicate paths and traversal are rejected as INVALID_ARGUMENT", async (t) => {
  const { host } = makeProject(t);
  const duplicate = await host.callTool("project_check_changes", {
    files: [
      { path: "res://a.gd", expectedHash: "x" },
      { path: "res://A.GD", expectedHash: "y" },
    ],
  });
  assert.equal(duplicate.ok, false);

  const traversal = await host.callTool("project_check_changes", {
    files: [{ path: "../outside.gd", expectedHash: "x" }],
  });
  assert.equal(traversal.ok, false);
  assert.equal((traversal as { ok: false; error: { code: string; details?: Record<string, unknown> } }).error.code, "INVALID_ARGUMENT");
  assert.equal((traversal as { ok: false; error: { details?: Record<string, unknown> } }).error.details?.["reason"], "traversal");
});

test("hashes interoperate with scene_get_tree expectedHash", async (t) => {
  const { dir, host } = makeProject(t);
  fs.writeFileSync(path.join(dir, "main.tscn"), '[gd_scene format=3]\n\n[node name="Root" type="Node2D"]\n');
  const tree = data(await host.callTool("scene_get_tree", { path: "res://main.tscn" }));
  const report = data(await host.callTool("project_check_changes", {
    files: [{ path: "res://main.tscn", expectedHash: tree["hash"] as string }],
  }));
  assert.deepEqual(report["unchanged"], ["res://main.tscn"]);
  assert.deepEqual(report["modified"], []);
});

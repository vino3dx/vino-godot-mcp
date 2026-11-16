// P1 数据保护锁:受保护目录(res://data/、res://assets/)+ 覆盖扩展名白名单。
//
// 夹具是 tests/fixture_project 的 mkdtemp 副本:仓库副本与任何真实工程都不会被操作。
// fixture 里没有 data/ 与 assets/(仓库不预置真实素材),用例在副本里自行铺出受保护内容。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { FileGuard } from "../src/core/filesystem/fileGuard.js";
import {
  PROTECTED_DIRS_ENV, assertNotProtected, protectedDirs,
} from "../src/core/filesystem/protectedPaths.js";
import { sha256Hex } from "../src/core/filesystem/safeWrite.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";

const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");
const quiet = createLogger("error", () => {});

/** 受保护目录内的"真实素材":被覆盖即数据损失,所有拒绝用例都要复核它没被动过。 */
const KEEP_GD = 'extends Node\nclass_name DataModulePlayer\n\n@export var speed: float = 300.0\n';
const KEEP_TXT = "hero data: must survive\n";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

interface Host { dir: string; host: ToolHost<AppContext> }

function writeFile(dir: string, rel: string, data: string | Buffer): void {
  const p = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

function makeHost(t: { after: (fn: () => void) => void }): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-prot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });

  writeFile(dir, "data/modules/player.gd", KEEP_GD);
  writeFile(dir, "data/modules/hero.txt", KEEP_TXT);
  writeFile(dir, "data/modules/icon.png", PNG_BYTES);
  writeFile(dir, "assets/textures/hero.png", PNG_BYTES);
  writeFile(dir, "assets/config.json", '{"a": 1}\n');
  writeFile(dir, "icon.png", PNG_BYTES); // 项目根下的非文本文件(不受保护目录覆盖)

  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
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

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8");
}

function readBytes(dir: string, rel: string): Buffer {
  return fs.readFileSync(path.join(dir, ...rel.split("/")));
}

/** script_create with overwrite=true —— 覆盖既有文件的唯一入口。 */
const overwrite = (host: ToolHost<AppContext>, scriptPath: string, content = "TOOL_WROTE_THIS\n") =>
  host.callTool("script_create", { scriptPath, content, overwrite: true });

// ────────────────────── 受保护目录:覆盖既有文件 ──────────────────────

test("editable text under res://data/ may be overwritten; binary assets stay protected", async (t) => {
  const { dir, host } = makeHost(t);

  // P0-C:源码/可编辑资源不再与导入缓存一视同仁。
  const gd = ok(await overwrite(host, "res://data/modules/player.gd", "extends Node\n# edited\n"));
  assert.equal(gd["changed"], true);
  assert.equal(read(dir, "data/modules/player.gd"), "extends Node\n# edited\n");

  writeFile(dir, "data/modules/icon.png", PNG_BYTES);
  const png = err(await overwrite(host, "res://data/modules/icon.png"));
  assert.equal(png.code, "PROTECTED_PATH");
  assert.match(png.message, /protected directory "res:\/\/data\/"/);
  assert.equal(png.details?.["protectedDir"], "res://data/");
  assert.equal(png.details?.["reason"], "readonly-in-protected-dir");
  assert.deepEqual(readBytes(dir, "data/modules/icon.png"), PNG_BYTES, "二进制素材必须逐字节不变");
});

test("res://assets/ allows .gd/.tscn/.tres/.json but still refuses binary assets", async (t) => {
  const { dir, host } = makeHost(t);
  writeFile(dir, "assets/ui/panel.tscn", '[gd_scene format=3]\n\n[node name="Root" type="Control"]\n');
  writeFile(dir, "assets/config/hero.tres", '[gd_resource type="Resource" format=3]\n\n[resource]\n');

  for (const [path, content] of [
    ["res://assets/config.json", '{"b": 2}\n'],
    ["res://assets/ui/panel.tscn", '[gd_scene format=3]\n\n[node name="Panel" type="Panel"]\n'],
    ["res://assets/config/hero.tres", '[gd_resource type="Resource" format=3]\n\n[resource]\nvalue = 1\n'],
  ] as const) {
    const result = ok(await overwrite(host, path, content));
    assert.equal(result["changed"], true, `${path} must be editable`);
  }
  assert.equal(read(dir, "assets/config.json"), '{"b": 2}\n');
  assert.ok(read(dir, "assets/ui/panel.tscn").includes('type="Panel"'));

  const png = err(await overwrite(host, "res://assets/textures/hero.png"));
  assert.equal(png.code, "PROTECTED_PATH", "受保护目录内的二进制仍然拒绝");
  assert.equal(png.details?.["protectedDir"], "res://assets/");
  assert.deepEqual(readBytes(dir, "assets/textures/hero.png"), PNG_BYTES);
});

test("creating a file inside a protected directory is still allowed", async (t) => {
  const { dir, host } = makeHost(t);

  const gd = ok(await host.callTool("script_create", {
    scriptPath: "res://data/modules/new_module.gd", content: "extends Node\n",
  }));
  assert.equal(gd["changed"], true);
  assert.equal(read(dir, "data/modules/new_module.gd"), "extends Node\n");

  // 非文本扩展名的"新建"不是覆盖:既有素材未被替换,规则只锁覆盖/删除/移动。
  const png = ok(await host.callTool("script_create", {
    scriptPath: "res://assets/textures/new_sprite.png", content: "placeholder\n",
  }));
  assert.equal(png["changed"], true);
  assert.deepEqual(readBytes(dir, "assets/textures/hero.png"), PNG_BYTES);
});

test("environment variable adds extra protected directories; the two defaults stay protected", async (t) => {
  const { dir, host } = makeHost(t);
  const previous = process.env[PROTECTED_DIRS_ENV];
  process.env[PROTECTED_DIRS_ENV] = "res://vendor/,  res://data , ../evil";
  t.after(() => {
    if (previous === undefined) delete process.env[PROTECTED_DIRS_ENV];
    else process.env[PROTECTED_DIRS_ENV] = previous;
  });
  writeFile(dir, "vendor/keep.txt", "vendor data\n");

  const extra = err(await overwrite(host, "res://vendor/keep.txt"));
  assert.equal(extra.code, "PROTECTED_PATH");
  assert.equal(extra.details?.["protectedDir"], "res://vendor/");
  assert.equal(extra.details?.["protectionLevel"], "strict");
  assert.equal(read(dir, "vendor/keep.txt"), "vendor data\n");

  // 环境变量追加的目录是 hard protection:文本也不放行(与 data/assets 的 editable 不同)。
  writeFile(dir, "vendor/module.gd", "extends Node\n");
  assert.equal(err(await overwrite(host, "res://vendor/module.gd")).details?.["protectionLevel"], "strict");
  assert.equal(read(dir, "vendor/module.gd"), "extends Node\n");

  // 默认两项不可被环境变量移除,重复项与无法解释的条目(../evil)被忽略
  assert.deepEqual(protectedDirs(process.env), ["data", "assets", "vendor"]);
  assert.deepEqual(readBytes(dir, "assets/textures/hero.png"), PNG_BYTES);
});

test(".godot/ cache, .import and .uid are hard-protected for every write entry", async (t) => {
  const { dir, host } = makeHost(t);
  writeFile(dir, ".godot/imported/hero.png-abc.ctex", "ENGINE_CACHE");
  writeFile(dir, "icon.png.import", '[remap]\n\nimporter="texture"\n');

  const cache = err(await overwrite(host, "res://.godot/imported/hero.png-abc.ctex"));
  assert.equal(cache.code, "PROTECTED_PATH");
  assert.equal(cache.details?.["reason"], "engine-cache");
  assert.equal(cache.details?.["protectionLevel"], "engine");

  const importFile = err(await overwrite(host, "res://icon.png.import"));
  assert.equal(importFile.code, "PROTECTED_PATH");
  assert.equal(importFile.details?.["reason"], "engine-owned-extension");

  const uidCreate = err(await host.callTool("script_create", { scriptPath: "res://player.gd.uid", content: "uid://new\n" }));
  assert.equal(uidCreate.code, "PROTECTED_PATH");
  assert.equal(fs.existsSync(path.join(dir, "player.gd.uid")), false);

  const cacheCreate = err(await host.callTool("script_create", { scriptPath: "res://.godot/imported/new.ctex", content: "x" }));
  assert.equal(cacheCreate.code, "PROTECTED_PATH");
  assert.equal(fs.existsSync(path.join(dir, ".godot", "imported", "new.ctex")), false);

  assert.equal(read(dir, ".godot/imported/hero.png-abc.ctex"), "ENGINE_CACHE");
  assert.equal(read(dir, "icon.png.import"), '[remap]\n\nimporter="texture"\n');
});

test("point edits (editText) cannot write into .godot/ but work inside assets/", async (t) => {
  const { dir, host } = makeHost(t);
  writeFile(dir, ".godot/fake.tscn", '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n');
  const cacheEdit = err(await host.callTool("scene_update_node_property", {
    path: "res://.godot/fake.tscn", nodePath: ".", key: "visible", value: "false",
  }));
  assert.equal(cacheEdit.code, "PROTECTED_PATH");
  assert.equal(cacheEdit.details?.["reason"], "engine-cache");

  writeFile(dir, "assets/ui/panel.tscn", '[gd_scene format=3]\n\n[node name="Root" type="Control"]\n');
  const edited = ok(await host.callTool("scene_update_node_property", {
    path: "res://assets/ui/panel.tscn", nodePath: ".", key: "mouse_filter", value: "2",
  }));
  assert.equal(edited["changed"], true);
  assert.ok(read(dir, "assets/ui/panel.tscn").includes("mouse_filter = 2"));
});

// ────────────────────── 绕过尝试 ──────────────────────

test("'..' traversal never reaches the protected check (FileGuard rejects the path first)", async (t) => {
  const { dir, host } = makeHost(t);

  for (const scriptPath of [
    "res://data/modules/../modules/player.gd",
    "res://data/../../data/modules/player.gd",
    "../data/modules/player.gd",
  ]) {
    const e = err(await overwrite(host, scriptPath));
    assert.equal(e.code, "INVALID_ARGUMENT", `expected ${scriptPath} to be rejected by FileGuard`);
    assert.equal(e.details?.["reason"], "traversal");
  }
  assert.equal(read(dir, "data/modules/player.gd"), KEEP_GD);
});

test("case variants cannot bypass the lock on a case-insensitive filesystem", async (t) => {
  const { dir, host } = makeHost(t);

  // 只有平台把变体解析到同一文件时它才构成绕过;大小写敏感的文件系统上它是另一个目录。
  const variantIsSameFile = fs.existsSync(path.join(dir, "DATA", "modules", "player.gd"));
  if (!variantIsSameFile) {
    t.diagnostic(`${process.platform}: filesystem is case-sensitive, "DATA" is a different directory — assertion not applicable`);
    return;
  }
  // 大小写变体仍命中受保护目录:用不可编辑的二进制来证明分类没有因大小写失效。
  const e = err(await overwrite(host, "res://DATA/modules/icon.png"));
  assert.equal(e.code, "PROTECTED_PATH");
  const assets = err(await overwrite(host, "res://Assets/textures/hero.png"));
  assert.equal(assets.code, "PROTECTED_PATH");
  assert.deepEqual(readBytes(dir, "assets/textures/hero.png"), PNG_BYTES);
});

test("links pointing into a protected directory cannot bypass the lock", async (t) => {
  const { dir, host } = makeHost(t);
  const guard = new FileGuard(dir);

  // 目录链接:res://link → res://assets(名义路径不在受保护目录内);目标是不可编辑的 PNG。
  const dirLink = path.join(dir, "link");
  try {
    fs.symlinkSync(path.join(dir, "assets"), dirLink, process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("this environment cannot create directory links");
    return;
  }
  assert.equal(guard.contains(path.join(dirLink, "textures", "hero.png")), true, "sanity: 链接仍在项目内");

  const viaDirLink = err(await overwrite(host, "res://link/textures/hero.png"));
  assert.equal(viaDirLink.code, "PROTECTED_PATH");
  assert.equal(viaDirLink.details?.["protectedDir"], "res://assets/");

  // 文件链接:res://scripts/alias.png → res://assets/textures/hero.png
  const fileLink = path.join(dir, "scripts", "alias.png");
  try {
    fs.symlinkSync(path.join(dir, "assets", "textures", "hero.png"), fileLink, "file");
  } catch {
    t.diagnostic("cannot create file links here; only the directory-link case was checked");
  }
  if (fs.existsSync(fileLink)) {
    const viaFileLink = err(await overwrite(host, "res://scripts/alias.png"));
    assert.equal(viaFileLink.code, "PROTECTED_PATH");
    assert.deepEqual(readBytes(dir, "assets/textures/hero.png"), PNG_BYTES);
  }
});

// ────────────────────── 扩展名白名单(与目录无关) ──────────────────────

test("outside protected directories: .gd may be overwritten, non-text extensions may not", async (t) => {
  const { dir, host } = makeHost(t);

  const gd = ok(await overwrite(host, "res://scripts/player.gd", "extends Node\n"));
  assert.equal(gd["changed"], true);
  assert.equal(read(dir, "scripts/player.gd"), "extends Node\n");

  const png = err(await overwrite(host, "res://icon.png"));
  assert.equal(png.code, "INVALID_ARGUMENT");
  assert.equal(png.details?.["reason"], "non-text-extension");
  assert.equal(png.details?.["extension"], ".png");
  assert.match(png.message, /Allowed extensions: \.gd, \.gdshader, \.gdshaderinc, \.tres, \.tscn, \.cfg, \.json, \.md, \.txt/);
  assert.deepEqual(readBytes(dir, "icon.png"), PNG_BYTES, "非文本文件必须逐字节不变");

  // 扩展名大小写不敏感(Windows/macOS 上 .GD 与 .gd 是同一类文件)
  ok(await host.callTool("script_create", { scriptPath: "res://scripts/upper.GD", content: "extends Node\n" }));
  assert.equal(ok(await overwrite(host, "res://scripts/upper.GD"))["changed"], true);

  // 其他文本扩展名(.json/.gdshader)覆盖允许
  writeFile(dir, "scripts/notes.json", "{}\n");
  assert.equal(ok(await overwrite(host, "res://scripts/notes.json", '{"b": 2}\n'))["changed"], true);
  assert.equal(read(dir, "scripts/notes.json"), '{"b": 2}\n');
});

// ────────────────────── 定点编辑(expectedHash 路径)不受影响 ──────────────────────

test("hash-guarded point edits keep working, including inside protected directories", async (t) => {
  const { dir, host } = makeHost(t);

  // script_update_export_default 走 FileService.editText,不受保护锁影响
  const edited = ok(await host.callTool("script_update_export_default", {
    path: "res://data/modules/player.gd", name: "speed", value: "500.0", expectedHash: sha256Hex(KEEP_GD),
  }));
  assert.equal(edited["changed"], true);
  assert.ok(read(dir, "data/modules/player.gd").includes("@export var speed: float = 500.0"));

  // 乐观并发仍然生效:hash 不匹配 → FILE_CHANGED,且不落盘
  const stale = err(await host.callTool("script_update_export_default", {
    path: "res://data/modules/player.gd", name: "speed", value: "999.0", expectedHash: sha256Hex(KEEP_GD),
  }));
  assert.equal(stale.code, "FILE_CHANGED");
  assert.ok(read(dir, "data/modules/player.gd").includes("500.0"), "FILE_CHANGED 不得覆盖磁盘内容");

  // createText 的 expectedHash 分支同样保留
  const mismatch = err(await host.callTool("script_create", {
    scriptPath: "res://scripts/player.gd", content: "extends Node\n", overwrite: true, expectedHash: "deadbeef",
  }));
  assert.equal(mismatch.code, "FILE_CHANGED");
});

// ────────────────────── 可复用守卫(供删除/移动类工具) ──────────────────────

test("assertNotProtected is reusable for future delete/move tools", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-prot-unit-"));
  try {
    fs.mkdirSync(path.join(dir, "data", "modules"), { recursive: true });
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    const guard = new FileGuard(dir);

    for (const op of ["delete", "move", "rename"] as const) {
      assert.throws(
        () => assertNotProtected(guard, path.join(dir, "data", "modules", "player.gd"), op),
        (e: unknown) => (e as { code?: string }).code === "PROTECTED_PATH"
          && (e as { details?: Record<string, unknown> }).details?.["op"] === op,
      );
      assert.throws(
        () => assertNotProtected(guard, path.join(dir, "assets"), op),
        (e: unknown) => (e as { code?: string }).code === "PROTECTED_PATH",
        "受保护目录自身也是受保护的",
      );
    }
    assert.doesNotThrow(() => assertNotProtected(guard, path.join(dir, "scripts", "player.gd"), "delete"));
    assert.doesNotThrow(() => assertNotProtected(guard, path.join(dir, "data_extra", "x.txt"), "delete"), "同前缀的兄弟目录不受影响");

    if (process.platform === "win32") {
      // 删除/移动在 editable 目录同样被拒;覆盖仅对可编辑文本放行。
      assert.throws(
        () => assertNotProtected(guard, path.join(dir, "DATA", "Modules", "player.gd"), "delete"),
        (e: unknown) => (e as { code?: string }).code === "PROTECTED_PATH",
      );
      assert.throws(
        () => assertNotProtected(guard, path.join(dir, "DATA", "Modules", "player.png"), "overwrite"),
        (e: unknown) => (e as { code?: string }).code === "PROTECTED_PATH",
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

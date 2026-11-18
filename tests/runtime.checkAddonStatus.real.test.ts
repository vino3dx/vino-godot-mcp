// P4:runtime_check_addon_status 的真实引擎测试(需要 GODOT_BIN;未设置时本文件的引擎用例整组 skip)。
//
// 约定(与 runtime.real.test.ts / runtime.inspectUi.real.test.ts 同):
//   - 测试工程一律现场写进 mkdtemp 临时目录,仓库副本保持原样;
//   - 每个用例显式 { timeout: 60000 },避免任何单一用例无限等待;
//   - "引擎不可用"用例不需要 Godot,始终运行(保证不依赖 GODOT_BIN 也有真实覆盖)。
//
// 实测(真实 Godot 4.6.3,2026-10-14)确认了本文件的断言口径:
//   - `--script` 模式:get_loaded_extensions() 返回 Array[String],元素是 .gdextension 的 res:// 路径;
//   - 有 .gdextension 但无 .godot/extension_list.cfg:引擎不加载、stderr 干净、连 .godot/ 都不会创建;
//   - extension_list.cfg 列出但库缺失:3 条 ERROR 打到 **stderr**,退出码仍为 0。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../src/core/logger.js";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { RuntimeService, type CheckAddonStatusOptions } from "../src/services/runtimeService.js";
import { runtimeCheckAddonStatus } from "../src/tools/runtime/checkAddonStatus.js";
import type { AddonStatusResult } from "../src/godot/runtime/checkAddonStatus.js";
import type { AppContext } from "../src/services/context.js";
import type { ToolResult } from "../src/types/index.js";

const GODOT_BIN = process.env["GODOT_BIN"];
const TIMEOUT_MS = 60_000;
const quiet = createLogger("error", () => {});
const skip = GODOT_BIN ? false : "GODOT_BIN 未设置";

const PROJECT_GODOT = ["config_version=5", "", "[application]", "", 'config/name="AddonReal"', ""].join("\n");

const FAKE_GDEXTENSION = [
  "[configuration]",
  "",
  'entry_symbol = "fake_library_init"',
  'compatibility_minimum = "4.6"',
  "",
  "[libraries]",
  "",
  'windows.debug.x86_64 = "res://bin/nope.dll"',
  'linux.release.x86_64 = "res://bin/nope.so"',
  "",
].join("\n");

interface Harness { dir: string; host: ToolHost<AppContext>; check: (o?: Partial<CheckAddonStatusOptions>) => Promise<AddonStatusResult> }

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

/** mkdtemp 工程 + ToolHost(与其它 real 测试同形;引擎可执行文件走 GODOT_PATH 注入)。 */
function makeHarness(
  t: { after: (fn: () => void) => void },
  files: Record<string, string>,
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-addon-real-"));
  t.after(() => {
    if (process.env["P4_KEEP"] === "1") {
      console.log(`P4 temp dir kept: ${dir}`);
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeFiles(dir, files);
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: GODOT_BIN } });
  const runtime = new RuntimeService({ godot, project, runQueue: new TaskQueue(new LockManager()) });
  const ctx = { runtime } as unknown as AppContext;
  return {
    dir,
    host: new ToolHost(new ToolRegistry<AppContext>().registerAll([runtimeCheckAddonStatus]), ctx, quiet),
    check: (o = {}) => runtime.checkAddonStatus({ projectPath: dir, tool: "runtime_check_addon_status", timeoutMs: TIMEOUT_MS, ...o }),
  };
}

function ok(r: ToolResult): AddonStatusResult {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: AddonStatusResult }).data;
}

/** 目录内容快照(相对路径 + 大小),用来证明探针没有乱写工程。 */
function snapshot(dir: string): string[] {
  const walk = (current: string): string[] =>
    fs.readdirSync(current, { withFileTypes: true }).flatMap((e) => {
      const abs = path.join(current, e.name);
      if (e.isDirectory()) return walk(abs);
      return [`${path.relative(dir, abs).split(path.sep).join("/")}:${fs.statSync(abs).size}`];
    });
  return walk(dir).sort();
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ────────────────────────────── 1) ClassDB 查询 ──────────────────────────────

test("real: classes 查询 —— Node2D 注册且可实例化,NoSuchClass123 不存在并进 class_missing", { skip, timeout: TIMEOUT_MS }, async (t) => {
  const { dir, host, check } = makeHarness(t, { "project.godot": PROJECT_GODOT });
  const before = { project: sha256(path.join(dir, "project.godot")), tree: snapshot(dir) };

  const r = await check({ classes: ["Node2D", "NoSuchClass123"] });
  assert.equal(r.engine.ok, true, JSON.stringify(r.engine));
  // 版本串由引擎的 MAJOR.MINOR[.PATCH] 拼成:补丁位为 0 时省略(4.6 active 版是 "4.6-stable (official)")。
  assert.match((r.engine as { version: string }).version, /^4\.\d+(\.\d+)?/);
  assert.equal((r.engine as { stderr?: string }).stderr, undefined, "脚本先判 exists,不应有引擎报错输出");
  assert.deepEqual(r.classes?.["Node2D"], { exists: true, can_instantiate: true });
  assert.deepEqual(r.classes?.["NoSuchClass123"], { exists: false, can_instantiate: false });
  assert.deepEqual(r.diagnosis, ["class_missing:NoSuchClass123"]);

  // 工具层同一条路径
  const viaTool = ok(await host.callTool("runtime_check_addon_status", { projectPath: dir, classes: ["Node2D"], timeoutMs: TIMEOUT_MS }));
  assert.deepEqual(viaTool.classes?.["Node2D"], { exists: true, can_instantiate: true });

  // 只读:project.godot 字节不变;本工程无 autoload,引擎跑完不应新增/改动任何文件
  assert.equal(sha256(path.join(dir, "project.godot")), before.project, "探针不得改动 project.godot");
  assert.deepEqual(snapshot(dir), before.tree, "探针不得在工程里落任何文件");
});

test("real: can_instantiate 只对已注册的类调用(不产生引擎 ERROR)", { skip, timeout: TIMEOUT_MS }, async (t) => {
  const { check } = makeHarness(t, { "project.godot": PROJECT_GODOT });
  const r = await check({ classes: ["Object", "Node", "NoSuchClass123"] });
  assert.equal(r.engine.ok, true);
  assert.equal((r.engine as { stderr?: string }).stderr, undefined);
  assert.equal(r.classes?.["Object"]?.exists, true);
  assert.equal(r.classes?.["Node"]?.exists, true);
  assert.equal(r.classes?.["NoSuchClass123"]?.exists, false);
});

// ────────────────────────────── 2) 插件 ──────────────────────────────

test("real: 已启用插件 —— plugin.cfg 齐全时报告 name/script,缺失时进 plugin_files_missing", { skip, timeout: TIMEOUT_MS }, async (t) => {
  const { check } = makeHarness(t, {
    "project.godot": [
      "config_version=5", "", "[application]", "", 'config/name="AddonReal"', "",
      "[editor_plugins]", "",
      'enabled=PackedStringArray("res://addons/ok/plugin.cfg", "res://addons/nocfg/plugin.cfg")',
      "",
    ].join("\n"),
    "addons/ok/plugin.cfg": '[plugin]\n\nname="Ok Plugin"\nversion="1.0"\nscript="ok_plugin.gd"\n',
    "addons/ok/ok_plugin.gd": "extends EditorPlugin\n",
  });

  const r = await check();
  assert.deepEqual(r.plugins, [
    { path: "res://addons/ok/plugin.cfg", cfgExists: true, name: "Ok Plugin", script: "ok_plugin.gd", scriptExists: true },
    { path: "res://addons/nocfg/plugin.cfg", cfgExists: false, scriptExists: false },
  ]);
  assert.ok(r.diagnosis.includes("plugin_files_missing:res://addons/nocfg/plugin.cfg"));
  // 插件齐全的那个不得被报成问题;也不得声称"已加载"
  assert.equal(r.diagnosis.includes("plugin_files_missing:res://addons/ok/plugin.cfg"), false);
  assert.equal(r.engine.ok, true);
});

// ────────────────────────────── 3) GDExtension ──────────────────────────────

test("real: 有 .gdextension 但没有 .godot/extension_list.cfg → 引擎不加载,报 extension_list_missing", { skip, timeout: TIMEOUT_MS }, async (t) => {
  const { dir, check } = makeHarness(t, { "project.godot": PROJECT_GODOT, "fake.gdextension": FAKE_GDEXTENSION });
  const before = snapshot(dir);

  const r = await check();
  assert.equal(r.engine.ok, true);
  assert.equal(r.extensionListFound, false);
  assert.equal(r.extensions.length, 1);
  const e = r.extensions[0]!;
  assert.equal(e.path, "res://fake.gdextension");
  assert.equal(e.entrySymbol, "fake_library_init");
  assert.equal(e.compatibilityMinimum, "4.6");
  assert.equal(e.listedInExtensionList, false);
  assert.equal(e.loaded, false, "未列入清单 → 引擎不会加载它");
  assert.deepEqual(e.libraries.map((l) => [l.key, l.exists]), [
    ["windows.debug.x86_64", false],
    ["linux.release.x86_64", false],
  ]);
  assert.ok(r.diagnosis.includes("extension_list_missing"));
  assert.equal(r.diagnosis.includes("extension_not_loaded:res://fake.gdextension"), false, "未列出时不给 not_loaded");
  // 实测:引擎完全不尝试加载,stderr 干净
  assert.equal((r.engine as { stderr?: string }).stderr, undefined);
  // 实测:运行期不会创建 .godot/
  assert.deepEqual(snapshot(dir), before, "探针不得在工程里落任何文件(含 .godot/)");
});

test("real: extension_list.cfg 列出该扩展但库文件缺失 → extension_not_loaded + library_missing + stderr 摘要", { skip, timeout: TIMEOUT_MS }, async (t) => {
  const { check } = makeHarness(t, {
    "project.godot": PROJECT_GODOT,
    "fake.gdextension": FAKE_GDEXTENSION,
    ".godot/extension_list.cfg": "res://fake.gdextension\n",
  });

  const r = await check();
  assert.equal(r.engine.ok, true, JSON.stringify(r.engine));
  assert.equal(r.extensionListFound, true);
  assert.equal(r.extensions[0]!.listedInExtensionList, true);
  assert.equal(r.extensions[0]!.loaded, false, "库加载失败 → 不在已加载列表里");
  assert.ok(r.diagnosis.includes("extension_not_loaded:res://fake.gdextension"));
  assert.equal(r.diagnosis.includes("extension_list_missing"), false);
  assert.equal(
    r.diagnosis.includes("library_missing:res://fake.gdextension"),
    process.platform === "win32" || process.platform === "linux",
    "只有本机平台的库(win/linux)全缺才报",
  );
  // 引擎的加载失败报错落在 engine.stderr 摘要里,工具不崩
  const stderr = (r.engine as { stderr?: string }).stderr;
  assert.ok(stderr, "库加载失败应给出 stderr 摘要");
  assert.match(stderr, /Error loading extension/);
});

// ────────────────────────────── 4) 引擎不可用(不需要 GODOT_BIN) ──────────────────────────────

test("real: 引擎不可用(GODOT_PATH 指向不存在文件)时静态部分仍返回", { timeout: TIMEOUT_MS }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-addon-nogodot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFiles(dir, {
    "project.godot": [
      "config_version=5", "", "[editor_plugins]", "",
      'enabled=PackedStringArray("res://addons/nocfg/plugin.cfg")',
      "",
    ].join("\n"),
    "fake.gdextension": FAKE_GDEXTENSION,
  });

  const runtime = new RuntimeService({
    godot: new GodotCliService({ env: { GODOT_PATH: path.join(dir, "nope.exe") } }),
    project: new ProjectResolver({ cwd: dir }),
    runQueue: new TaskQueue(new LockManager()),
  });
  const r = await runtime.checkAddonStatus({ projectPath: dir, classes: ["Node2D", "NoSuchClass123"], timeoutMs: TIMEOUT_MS, tool: "runtime_check_addon_status" });

  assert.equal(r.engine.ok, false);
  assert.deepEqual((r.engine as { error: { code: string } }).error.code, "GODOT_NOT_FOUND");
  // 静态部分照常:
  assert.equal(r.extensions[0]!.path, "res://fake.gdextension");
  assert.equal(r.extensions[0]!.loaded, null, "引擎没跑成 → 未知,不是 false");
  assert.equal(r.classes, null, "类结果未知 → null,不得据此报 class_missing");
  assert.deepEqual(r.plugins, [{ path: "res://addons/nocfg/plugin.cfg", cfgExists: false, scriptExists: false }]);
  // extension_list_missing 与 plugin_files_missing 是静态判定;library_missing 同样是静态判定(不依赖引擎),
  // 而 extension_not_loaded 需要引擎成功,这里给不出来。
  assert.deepEqual(
    r.diagnosis.filter((d) => d !== "library_missing:res://fake.gdextension"),
    ["extension_list_missing", "plugin_files_missing:res://addons/nocfg/plugin.cfg"],
  );
  assert.equal(
    r.diagnosis.includes("library_missing:res://fake.gdextension"),
    process.platform === "win32" || process.platform === "linux",
  );
  assert.equal(r.diagnosis.some((d) => d.startsWith("extension_not_loaded:")), false, "引擎没跑成不给 not_loaded");
});

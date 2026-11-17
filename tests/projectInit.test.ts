// T028:project_init —— 没有 project.godot 时的冷启动自举。
//
// 覆盖:
//   1) 空目录(甚至还不存在的目录)完整初始化,产物可被 ProjectService 解析;
//   2) dryRun=true 零写盘,且预览内容与真实落盘内容逐字节一致;
//   3) project.godot 已存在且 overwrite=false → ALREADY_EXISTS,零写盘、零改动;
//   4) overwrite=true 只重建 project.godot,已有 .gitignore / 主场景保持原样;
//   5) 参数校验(相对路径、文件路径、非法 renderer、越界 mainScene、同名主场景扩展名…);
//   6) 端到端自举:project_init → project_get_config → script_create → scene_add_node。
//
// 真实引擎加载验证在 projectInit.real.test.ts(需要 GODOT_BIN / GODOT_PATH)。
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
import { ProjectService } from "../src/services/projectService.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";
import type { ProjectInitResult } from "../src/services/projectInitService.js";

const quiet = createLogger("error", () => {});

interface Harness {
  /** mkdtemp 出来的父目录(临时工程都建在它下面,清理一次即可) */
  base: string;
  /** 目标工程根:默认还不存在,用来证明"从零创建" */
  target: string;
  host: ToolHost<AppContext>;
}

function makeHarness(t: { after: (fn: () => void) => void }): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-init-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // 解析基准故意放在"没有 project.godot 的目录":任何 cwd 回落都会立刻暴露出来。
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: base }));
  return {
    base,
    target: path.join(base, "fresh-project"),
    host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet),
  };
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

function read(abs: string): string {
  return fs.readFileSync(abs, "utf8");
}

const MAIN_SCENE = '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n';

// ────────────────────────────── 1) 正常初始化 ──────────────────────────────

test("project_init: 空目录从零自举 —— 生成 project.godot / 目录骨架 / 主场景 / .gitignore", async (t) => {
  const { target, host } = makeHarness(t);

  // 冷启动阻断的原始症状:没有 project.godot 时读工具直接拒绝工作。
  assert.equal(err(await host.callTool("project_get_config", { projectPath: target })).code, "PROJECT_NOT_FOUND");
  assert.equal(fs.existsSync(target), false, "目标目录此时还不存在");

  const data = ok(await host.callTool("project_init", { projectPath: target, projectName: "Bootstrap Demo" })) as unknown as ProjectInitResult;
  assert.equal(data.projectRoot, path.resolve(target));
  assert.equal(data.projectName, "Bootstrap Demo");
  assert.equal(data.renderer, "forward_plus");
  assert.equal(data.mainScene, "res://main.tscn");
  assert.equal(data.dryRun, false);
  assert.equal(data.overwrite, false);
  assert.deepEqual(data.dirs.map((d) => [d.resPath, d.status]), [
    ["res://scenes", "created"],
    ["res://scripts", "created"],
    ["res://assets", "created"],
  ]);
  assert.deepEqual(data.files.map((f) => [f.resPath, f.status]), [
    ["res://project.godot", "created"],
    ["res://.gitignore", "created"],
    ["res://main.tscn", "created"],
  ]);

  const projectGodot = read(path.join(target, "project.godot"));
  assert.ok(projectGodot.startsWith("; Engine configuration file.\n"), "保留 Godot 自带的文件头注释");
  assert.ok(projectGodot.includes("\nconfig_version=5\n"), "config_version=5 必须在首个段之前");
  assert.ok(projectGodot.includes('config/name="Bootstrap Demo"'));
  assert.ok(projectGodot.includes('run/main_scene="res://main.tscn"'));
  assert.ok(projectGodot.includes('renderer/rendering_method="forward_plus"'));
  // 段与段之间空一行、键值无多余空格 —— 与 Godot 自己写出的格式一致。
  assert.ok(projectGodot.includes('[application]\n\nconfig/name="Bootstrap Demo"\n'));
  assert.ok(projectGodot.includes('[rendering]\n\nrenderer/rendering_method="forward_plus"\n'));

  for (const dir of ["scenes", "scripts", "assets"]) {
    assert.ok(fs.statSync(path.join(target, dir)).isDirectory(), `${dir}/ 必须是目录`);
  }
  assert.equal(read(path.join(target, "main.tscn")), MAIN_SCENE);
  const gitignore = read(path.join(target, ".gitignore"));
  assert.ok(gitignore.includes(".godot/"), ".gitignore 必须忽略引擎缓存");
  assert.ok(gitignore.includes(".vino-godot-mcp/"), ".gitignore 必须忽略 MCP 自身缓存");

  // 产物必须能被 project_get_config 的解析器原样读回(链路真正打通,而不是只写了文件)。
  const parsed = new ProjectService().getConfig(projectGodot);
  assert.equal(parsed.configVersion, 5);
  assert.deepEqual(parsed.sections.map((s) => s.name), ["application", "rendering"]);
  assert.equal(new ProjectService().getConfigValue(projectGodot, "application", "config/name"), '"Bootstrap Demo"');
  assert.equal(new ProjectService().getConfigValue(projectGodot, "application", "run/main_scene"), '"res://main.tscn"');
  assert.equal(new ProjectService().getConfigValue(projectGodot, "rendering", "renderer/rendering_method"), '"forward_plus"');
});

test("project_init: 已有空目录(存在但什么都没有)同样可以初始化", async (t) => {
  const { target, host } = makeHarness(t);
  fs.mkdirSync(target, { recursive: true });
  const data = ok(await host.callTool("project_init", { projectPath: target, projectName: "Existing Empty" })) as unknown as ProjectInitResult;
  assert.equal(data.projectRoot, path.resolve(target));
  assert.ok(fs.existsSync(path.join(target, "project.godot")));
});

// ────────────────────────────── 2) dryRun ──────────────────────────────

test("project_init: dryRun=true 返回内容预览且零写盘(预览与真实落盘逐字节一致)", async (t) => {
  const { target, host } = makeHarness(t);
  const preview = ok(await host.callTool("project_init", { projectPath: target, projectName: "Preview Project", dryRun: true })) as unknown as ProjectInitResult;

  assert.equal(preview.dryRun, true);
  assert.equal(fs.existsSync(target), false, "dryRun 不得创建目录");
  assert.deepEqual(preview.dirs.map((d) => d.status), ["planned", "planned", "planned"]);
  assert.deepEqual(preview.files.map((f) => f.status), ["planned", "planned", "planned"]);
  for (const file of preview.files) {
    assert.equal(typeof file.content, "string", `${file.resPath} 必须给出内容预览`);
    assert.equal(file.hash.length, 64, "预览同样给出内容 sha256");
  }
  assert.ok(preview.files[0]!.content!.includes('config/name="Preview Project"'));
  assert.equal(preview.files[2]!.content, MAIN_SCENE);
  assert.match(String((preview as unknown as Record<string, unknown>)["message"]), /nothing was written/);

  // 去掉 dryRun 真正落盘:与预览内容必须完全相同。
  ok(await host.callTool("project_init", { projectPath: target, projectName: "Preview Project" }));
  for (const file of preview.files) {
    assert.equal(read(file.absPath), file.content, `${file.resPath} 的预览内容与实际内容不一致`);
  }
});

test("project_init: dryRun=true 但已存在 project.godot 且 overwrite=false 时仍然拒绝(预览不能掩盖冲突)", async (t) => {
  const { target, host } = makeHarness(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "project.godot"), "config_version=5\n");

  const error = err(await host.callTool("project_init", { projectPath: target, projectName: "X", dryRun: true }));
  assert.equal(error.code, "ALREADY_EXISTS");
  assert.equal(read(path.join(target, "project.godot")), "config_version=5\n");
});

// ────────────────────────────── 3) 防覆盖 ──────────────────────────────

test("project_init: project.godot 已存在 + overwrite=false → ALREADY_EXISTS,零写盘零改动", async (t) => {
  const { target, host } = makeHarness(t);
  fs.mkdirSync(target, { recursive: true });
  const existing = "; hand written\nconfig_version=5\n\n[application]\n\nconfig/name=\"Real Game\"\n";
  fs.writeFileSync(path.join(target, "project.godot"), existing);

  const error = err(await host.callTool("project_init", { projectPath: target, projectName: "Intruder" }));
  assert.equal(error.code, "ALREADY_EXISTS");
  assert.equal((error.details as { projectFile: string }).projectFile, path.join(target, "project.godot"));
  assert.match(error.message, /overwrite=true/);

  // 逐字节不变,且没有留下任何脚手架残留。
  assert.equal(read(path.join(target, "project.godot")), existing);
  assert.deepEqual(fs.readdirSync(target), ["project.godot"]);
});

test("project_init: overwrite=true 只重建 project.godot,已有 .gitignore 与主场景原样保留", async (t) => {
  const { target, host } = makeHarness(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "project.godot"), "config_version=5\n\n[application]\n\nconfig/name=\"Old\"\n");
  fs.writeFileSync(path.join(target, ".gitignore"), "my-own-rule\n");
  fs.writeFileSync(path.join(target, "main.tscn"), '[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n\n[node name="Player" type="Node2D" parent="."]\n');

  const data = ok(await host.callTool("project_init", { projectPath: target, projectName: "Rebuilt", overwrite: true })) as unknown as ProjectInitResult;
  assert.deepEqual(data.files.map((f) => [f.resPath, f.status]), [
    ["res://project.godot", "updated"],
    ["res://.gitignore", "skipped"],
    ["res://main.tscn", "skipped"],
  ]);
  assert.match(data.files[1]!.reason!, /\.gitignore/);
  assert.match(data.files[2]!.reason!, /create-only/);

  assert.ok(read(path.join(target, "project.godot")).includes('config/name="Rebuilt"'));
  assert.ok(read(path.join(target, "project.godot")).includes('run/main_scene="res://main.tscn"'));
  assert.equal(read(path.join(target, ".gitignore")), "my-own-rule\n", "用户的 .gitignore 永不被改写");
  assert.ok(read(path.join(target, "main.tscn")).includes('name="Player"'), "真实主场景不能被空骨架覆盖");
  assert.equal(data.files[0]!.status, "updated");
});

test("project_init: 重复执行(overwrite=true)内容不变时报告 unchanged,不会反复改文件", async (t) => {
  const { target, host } = makeHarness(t);
  ok(await host.callTool("project_init", { projectPath: target, projectName: "Idempotent" }));
  const before = fs.statSync(path.join(target, "project.godot")).mtimeMs;
  const data = ok(await host.callTool("project_init", { projectPath: target, projectName: "Idempotent", overwrite: true })) as unknown as ProjectInitResult;
  assert.equal(data.files[0]!.status, "unchanged");
  assert.equal(fs.statSync(path.join(target, "project.godot")).mtimeMs, before);
});

// ────────────────────────────── 4) renderer / mainScene / 目录骨架 ──────────────────────────────

test("project_init: 自定义 renderer / mainScene / 关闭目录骨架", async (t) => {
  const { target, host } = makeHarness(t);
  const data = ok(await host.callTool("project_init", {
    projectPath: target,
    projectName: "Compat Game",
    renderer: "gl_compatibility",
    mainScene: "res://levels/start.tscn",
    createDefaultDirs: false,
  })) as unknown as ProjectInitResult;

  const projectGodot = read(path.join(target, "project.godot"));
  assert.ok(projectGodot.includes('renderer/rendering_method="gl_compatibility"'));
  assert.ok(projectGodot.includes('run/main_scene="res://levels/start.tscn"'));
  assert.equal(data.mainScene, "res://levels/start.tscn");
  assert.equal(read(path.join(target, "levels", "start.tscn")), MAIN_SCENE, "缺口多级目录一并创建");
  assert.equal(fs.existsSync(path.join(target, "scenes")), false, "createDefaultDirs=false 不建标准目录");
  assert.deepEqual(data.dirs, []);

  for (const renderer of ["forward_plus", "mobile", "gl_compatibility"]) {
    const other = path.join(path.dirname(target), `renderer-${renderer}`);
    ok(await host.callTool("project_init", { projectPath: other, projectName: `R ${renderer}`, renderer }));
    assert.ok(read(path.join(other, "project.godot")).includes(`renderer/rendering_method="${renderer}"`));
  }
});

test("project_init: createMainScene=false 仍写 run/main_scene,但不生成场景文件", async (t) => {
  const { target, host } = makeHarness(t);
  const data = ok(await host.callTool("project_init", {
    projectPath: target,
    projectName: "No Scene",
    mainScene: "res://main.tscn",
    createMainScene: false,
  })) as unknown as ProjectInitResult;
  assert.ok(read(path.join(target, "project.godot")).includes('run/main_scene="res://main.tscn"'));
  assert.equal(fs.existsSync(path.join(target, "main.tscn")), false);
  assert.deepEqual(data.files.map((f) => f.resPath), ["res://project.godot", "res://.gitignore"]);
});

// ────────────────────────────── 5) 参数校验 ──────────────────────────────

test("project_init: 参数校验 —— 相对路径/文件路径/非法名称/越界 mainScene 一律 INVALID_ARGUMENT", async (t) => {
  const { target, host } = makeHarness(t);
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["相对 projectPath(禁止回落 cwd)", { projectPath: "fresh-project", projectName: "X" }, /absolute path/],
    ["空 projectPath", { projectPath: "   ", projectName: "X" }, /required/],
    ["缺少 projectName(schema required)", { projectPath: target }, /Invalid arguments/],
    ["projectName 含引号", { projectPath: target, projectName: 'Bad "Name"' }, /double quotes/],
    ["renderer 不在枚举内(schema enum)", { projectPath: target, projectName: "X", renderer: "vulkan" }, /Invalid arguments/],
    ["mainScene 越界", { projectPath: target, projectName: "X", mainScene: "res://../escape.tscn" }, /must not contain "\.\."/],
    ["mainScene 不是 .tscn", { projectPath: target, projectName: "X", mainScene: "res://main.scn" }, /\.tscn/],
    ["mainScene 指向项目根", { projectPath: target, projectName: "X", mainScene: "res://" }, /not the project root/],
  ];
  for (const [label, args, message] of cases) {
    const error = err(await host.callTool("project_init", args));
    assert.equal(error.code, "INVALID_ARGUMENT", `${label} 必须是 INVALID_ARGUMENT,实际 ${error.code}`);
    assert.match(error.message, message, label);
  }
  assert.equal(fs.existsSync(target), false, "校验失败的调用不得留下任何文件");

  // projectPath 指向已存在的普通文件
  const asFile = path.join(path.dirname(target), "not-a-dir.txt");
  fs.writeFileSync(asFile, "x");
  assert.equal(err(await host.callTool("project_init", { projectPath: asFile, projectName: "X" })).code, "INVALID_ARGUMENT");
  // 文件系统根目录拒绝(避免把工程铺到磁盘根)
  assert.match(err(await host.callTool("project_init", { projectPath: path.parse(asFile).root, projectName: "X" })).message, /filesystem root/);
});

// ────────────────────────────── 6) 端到端自举 ──────────────────────────────

test("project_init → project_get_config → script_create → scene_add_node 端到端自举", async (t) => {
  const { target, host } = makeHarness(t);

  ok(await host.callTool("project_init", { projectPath: target, projectName: "Self Boot" }));

  // 1) 读配置:此前会 PROJECT_NOT_FOUND,现在能读到刚写的内容
  const config = ok(await host.callTool("project_get_config", { projectPath: target }));
  assert.equal((config["config"] as { configVersion?: number }).configVersion, 5);
  assert.equal((config["hash"] as string).length, 64);

  // 2) 写脚本(冷启动后 file 服务可以正常解析项目根)
  const script = ok(await host.callTool("script_create", {
    projectPath: target,
    scriptPath: "res://scripts/player.gd",
    content: "extends Node2D\n\nfunc _ready() -> void:\n\tprint(\"boot\")\n",
  }));
  assert.equal(script["changed"], true);
  assert.ok(read(path.join(target, "scripts", "player.gd")).includes("extends Node2D"));

  // 3) 改场景(主场景骨架 → 加节点)
  const added = ok(await host.callTool("scene_add_node", {
    projectPath: target,
    path: "res://main.tscn",
    parentPath: ".",
    nodeType: "Node2D",
    nodeName: "Player",
  }));
  assert.equal(added["changed"], true);
  assert.equal(added["nodePath"], "Player");

  const tree = ok(await host.callTool("scene_get_tree", { projectPath: target, path: "res://main.tscn" }));
  assert.deepEqual((tree["tree"] as { nodes: Array<{ path: string }> }).nodes.map((n) => n.path), [".", "Player"]);
});

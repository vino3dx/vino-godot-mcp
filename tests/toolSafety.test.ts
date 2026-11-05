// P0 安全语义回归:工具注解必须与真实副作用一致。
//
// 两条独立证据:
//   1) 运行时元数据:allTools 里每个工具的 annotations(runtime_visual_debug 曾经声明 readOnly=true,
//      实际会起两个 Godot 进程、执行工程代码并写临时文件)。
//   2) 源码扫描:按 `export const ... : ToolDefinition` 切分每个工具定义块,检查它真正调用了哪些服务。
//      只要调用了引擎(runtime/godotApi/validation)、写了工程文件(file/batchFile)或启动/停止常驻进程,
//      就不允许声明 readOnly。
//
// 这条测试故意不依赖描述文字(描述可能写错),只看注解 + 调用。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allTools } from "../src/tools/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 测试可能从 dist/ 或临时 outDir 运行,所以先看 cwd,再逐级向上找含 src/tools 的仓库根。 */
function findRepoRoot(): string {
  const starts = [process.cwd(), HERE, path.resolve(HERE, ".."), path.resolve(HERE, "../..")];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src", "tools", "index.ts"))) return dir;
      dir = path.dirname(dir);
    }
  }
  throw new Error(`cannot locate repository root (cwd=${process.cwd()}, module=${HERE})`);
}

function collectTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTs(abs);
    return entry.name.endsWith(".ts") ? [abs] : [];
  });
}

interface ToolBlock {
  file: string;
  name: string;
  readOnly: boolean;
  /** 源码里字面量声明的 dependency(P1-B:用来证明元数据不是运行期算出来的)。 */
  dependency: string | undefined;
  body: string;
}

/** 一个文件可能定义多个工具(sessionTools.ts / metadata.ts),按 export 边界切开。 */
function scanToolBlocks(): ToolBlock[] {
  const root = findRepoRoot();
  const files = collectTs(path.join(root, "src", "tools")).filter((f) => !f.endsWith(`${path.sep}index.ts`));
  const blocks: ToolBlock[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const part of text.split(/(?=export const \w+: ToolDefinition)/)) {
      if (!part.startsWith("export const")) continue;
      const name = /name:\s*"([a-z0-9_]+)"/.exec(part)?.[1];
      if (!name) continue;
      blocks.push({
        file: path.relative(root, file).replace(/\\/g, "/"),
        name,
        readOnly: /annotations:\s*\{[^}]*readOnly:\s*true/.test(part),
        dependency: /dependency:\s*"([a-z]+)"/.exec(part)?.[1],
        body: part,
      });
    }
  }
  return blocks;
}

/** 需要引擎进程 / 会写文件系统 / 会控制常驻进程的调用。 */
const SIDE_EFFECTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "engine process (ctx.runtime.*)", pattern: /ctx\.runtime\./ },
  { label: "engine API dump (ctx.godotApi.*)", pattern: /ctx\.godotApi\./ },
  { label: "engine validation (ctx.validation.*)", pattern: /ctx\.validation\./ },
  { label: "project file write (ctx.file.editText/createText, ctx.batchFile)", pattern: /ctx\.file\.(?:editText|createText)|ctx\.batchFile\./ },
  { label: "runtime session lifecycle (ctx.runtimeSessions.start/stop)", pattern: /ctx\.runtimeSessions\.(?:start|stop)/ },
];

function byName(name: string) {
  const tool = allTools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} must be registered`);
  return tool;
}

test("tool source scan and registry agree on the tool set", () => {
  const blocks = scanToolBlocks();
  assert.deepEqual(blocks.map((b) => b.name).sort(), allTools.map((t) => t.name).sort());
});

test("no tool claims readOnly while calling the engine, writing project files, or driving a session", () => {
  const violations: string[] = [];
  for (const block of scanToolBlocks()) {
    if (!block.readOnly) continue;
    const hits = SIDE_EFFECTS.filter((effect) => effect.pattern.test(block.body)).map((effect) => effect.label);
    if (hits.length > 0) violations.push(`${block.name} (${block.file}) declares readOnly=true but calls ${hits.join(", ")}`);
  }
  assert.deepEqual(violations, [], `readOnly annotation contradicts the real call chain:\n${violations.join("\n")}`);
});

test("engine-executing and file-writing tools are advertised as not read-only", () => {
  const mustBeWritable = [
    // 起引擎跑场景 / 探测 / 导出
    "runtime_run_project", "runtime_run_scene", "runtime_export_project",
    "runtime_capture_screenshot", "runtime_inspect_ui", "runtime_visual_debug", "runtime_check_addon_status",
    "runtime_start_session", "runtime_stop_session",
    // 起引擎做校验 / 语法检查
    "project_validate",
    // 起引擎 dump ClassDB 并写缓存
    "class_get_info", "class_search", "class_validate_member", "scene_get_node_info",
    // 写工程文件
    "scene_add_node", "scene_remove_node", "scene_update_node_property", "scene_reparent_node",
    "resource_update_property", "resource_add_or_update_external",
    "project_set_config", "project_input_update", "project_apply_changes",
    "script_create", "script_update_function", "script_update_export_default",
  ] as const;
  for (const name of mustBeWritable) assert.equal(byName(name).annotations.readOnly, false, `${name} must not claim readOnly`);
});

test("runtime_visual_debug declares its real side effects", () => {
  const tool = byName("runtime_visual_debug");
  // 实际调用链: handler -> ctx.runtime.inspectUi + ctx.runtime.captureScreenshot(两者各自读/写只读注解为 false)
  assert.equal(tool.annotations.readOnly, false);
  assert.equal(tool.annotations.idempotent, true);
  assert.equal(tool.runtimeRequired, true);
  assert.match(tool.description, /NOT read-only/i, "description must warn that the probe executes project code");
});

test("destructive tools are marked and never read-only", () => {
  for (const name of ["project_apply_changes", "scene_remove_node", "scene_disconnect_signal", "runtime_stop_session"] as const) {
    const tool = byName(name);
    assert.equal(tool.annotations.destructive, true, `${name} must be destructive`);
    assert.equal(tool.annotations.readOnly, false, `${name} must not be readOnly`);
  }
  const conflicting = allTools.filter((t) => t.annotations.readOnly && t.annotations.destructive).map((t) => t.name);
  assert.deepEqual(conflicting, []);
});

test("editor bridge tools stay read-only until a write channel exists", () => {
  // 依据 docs/GODOT_NATIVE_BRIDGE.md:编辑器桥当前只有只读能力。若将来加了写侧工具,这条断言会提醒同步文档。
  for (const name of ["editor_get_scene", "editor_get_tree", "editor_get_node", "editor_get_layout", "project_capabilities"] as const) {
    assert.equal(byName(name).annotations.readOnly, true, `${name} reads the editor and must stay readOnly`);
  }
});

// ---------------------------------------------------------------- P1-B 依赖元数据
//
// domain 是"功能领域",dependency 是"调用所需的外部能力",两者正交:
//   none   = 只需要 Node + 本地文件系统(含 .tscn/.tres/.gd 静态解析与写入)
//   godot  = 需要 Godot 可执行文件/引擎能力(CLI 探测、headless 运行、ClassDB dump、引擎校验、Godot 创建的会话)
//   bridge = 需要运行中的 Godot Editor Bridge
// 断言直接读真实 ToolDefinition(allTools),不维护与源码脱离的工具清单;
// 分类基线用"domain 默认值 + 逐个例外"表达,避免复制 59 行表格。

const DEPENDENCIES = ["none", "godot", "bridge"] as const;
type Dependency = (typeof DEPENDENCIES)[number];

/** 每个 domain 的默认依赖。理由见下;例外必须单独列出并说明。 */
const DOMAIN_DEFAULT_DEPENDENCY: Record<string, Dependency> = {
  utility: "none",
  asset: "none",
  scene: "none",
  resource: "none",
  project: "none",
  shader: "none",
  script: "none",
  // ClassDB 元数据来自 `godot --dump-extension-api` 的真实 dump。
  class: "godot",
  // runtime 域全部需要 Godot 可执行文件,或依赖由 Godot 创建的会话。
  runtime: "godot",
  // editor 域读的是运行中的 Editor 场景,只有 EditorPlugin 通道能回答。
  editor: "bridge",
};

/** 与 domain 默认值不同的工具(逐条给理由,绝不按名称前缀推断)。 */
const DEPENDENCY_EXCEPTIONS: Record<string, Dependency> = {
  // scene 域唯一的引擎依赖:节点信息里的 nodeType 要查 ClassDB。
  scene_get_node_info: "godot",
  // project 域里的两个例外:校验要起引擎,能力探测要走编辑器桥。
  project_validate: "godot",
  project_capabilities: "bridge",
};

function dependencyOf(name: string): Dependency {
  const tool = byName(name);
  return tool.dependency;
}

test("P1-B: every registered tool declares an explicit dependency", () => {
  // `!t.dependency` 同时覆盖"字段缺失(undefined)"和"空串"两种情况。
  const undeclared = allTools.filter((t) => !t.dependency).map((t) => t.name);
  assert.deepEqual(undeclared, [], `tools without a dependency field: ${undeclared.join(", ")}`);
  // 源码里也必须是字面量声明:只有一个 dependency 键,且与注册表暴露的值一致。
  for (const block of scanToolBlocks()) {
    const occurrences = [...block.body.matchAll(/dependency:\s*"([a-z]+)"/g)];
    assert.equal(occurrences.length, 1, `${block.name} (${block.file}) must declare exactly one dependency literal`);
  }
});

test("P1-B: dependency is only none / godot / bridge", () => {
  const illegal = allTools.filter((t) => !(DEPENDENCIES as readonly string[]).includes(t.dependency));
  assert.deepEqual(illegal.map((t) => `${t.name}=${String(t.dependency)}`), []);
  const illegalSource = scanToolBlocks().filter((b) => b.dependency === undefined || !(DEPENDENCIES as readonly string[]).includes(b.dependency));
  assert.deepEqual(illegalSource.map((b) => `${b.name} (${b.file})`), []);
});

test("P1-B: dependency classification matches the audited baseline (37 none / 17 godot / 5 bridge)", () => {
  const counts: Record<string, number> = {};
  for (const tool of allTools) counts[tool.dependency] = (counts[tool.dependency] ?? 0) + 1;
  assert.deepEqual(counts, { none: 37, godot: 17, bridge: 5 }, `actual classification: ${JSON.stringify(counts)}`);
  assert.equal(allTools.length, 59, "the audited baseline covers exactly 59 tools");
});

test("P1-B: every tool matches its domain default or an explicit exception", () => {
  const mismatched: string[] = [];
  for (const tool of allTools) {
    const expected = DEPENDENCY_EXCEPTIONS[tool.name] ?? DOMAIN_DEFAULT_DEPENDENCY[tool.domain];
    assert.ok(expected, `domain "${tool.domain}" (${tool.name}) has no dependency rule; add one instead of guessing`);
    if (tool.dependency !== expected) mismatched.push(`${tool.name}: domain=${tool.domain} expected=${expected} actual=${tool.dependency}`);
  }
  assert.deepEqual(mismatched, [], `dependency contradicts the audit:\n${mismatched.join("\n")}`);
});

test("P1-B: domain and dependency are independent dimensions", () => {
  // project 域同时含 none(文件级)、godot(引擎校验)与 bridge(编辑器能力探测):domain 不能推导 dependency。
  const projectDeps = new Set(allTools.filter((t) => t.domain === "project").map((t) => t.dependency));
  assert.deepEqual([...projectDeps].sort(), ["bridge", "godot", "none"]);
  // 反过来 dependency=godot 的工具横跨多个 domain。
  const godotDomains = new Set(allTools.filter((t) => t.dependency === "godot").map((t) => t.domain));
  assert.deepEqual([...godotDomains].sort(), ["class", "project", "runtime", "scene"]);
});

test("P1-B: editor domain tools and project_capabilities depend on the bridge", () => {
  for (const tool of allTools.filter((t) => t.domain === "editor")) {
    assert.equal(tool.dependency, "bridge", `${tool.name} reads the running editor and must depend on the bridge`);
  }
  assert.equal(dependencyOf("project_capabilities"), "bridge", "project domain, but it needs the Editor Bridge");
  const bridgeTools = allTools.filter((t) => t.dependency === "bridge").map((t) => t.name).sort();
  assert.deepEqual(bridgeTools, ["editor_get_layout", "editor_get_node", "editor_get_scene", "editor_get_tree", "project_capabilities"]);
});

test("P1-B: engine-backed tools (class / node info / validate / runtime probes) depend on godot", () => {
  for (const name of ["class_get_info", "class_search", "class_validate_member", "scene_get_node_info", "project_validate", "runtime_get_version", "runtime_check_addon_status"] as const) {
    assert.equal(dependencyOf(name), "godot", `${name} executes or requires the Godot engine`);
  }
  // 依赖 Godot 创建的会话:即使不亲自起进程,也归入 godot。
  for (const name of ["runtime_get_session", "runtime_read_session_logs"] as const) {
    assert.equal(dependencyOf(name), "godot", `${name} depends on a session created by Godot`);
  }
});

test("P1-B: dependency cannot be inferred from runtimeRequired", () => {
  // runtimeRequired=false 同时对应三种 dependency → 它不是"调用是否需要 Godot"。
  const byRuntimeRequired = new Map<string, Set<string>>();
  for (const tool of allTools) {
    const key = String(tool.runtimeRequired);
    const set = byRuntimeRequired.get(key) ?? new Set<string>();
    set.add(tool.dependency);
    byRuntimeRequired.set(key, set);
  }
  assert.deepEqual([...(byRuntimeRequired.get("false") ?? [])].sort(), ["bridge", "godot", "none"],
    "runtimeRequired=false spans all three dependencies, so it cannot derive dependency");
  // 具体的反例:需要引擎/桥,却没有启动门槛。
  for (const name of ["runtime_get_version", "runtime_check_addon_status", "runtime_get_session", "project_capabilities"] as const) {
    assert.equal(byName(name).runtimeRequired, false, `${name} must not claim runtimeRequired (it starts no Runtime Adapter)`);
    assert.notEqual(dependencyOf(name), "none", `${name} still needs Godot or the bridge`);
  }
});

test("P1-B: the dependency in source equals the dependency in the registry", () => {
  const declared = new Map(scanToolBlocks().map((b) => [b.name, b.dependency]));
  for (const tool of allTools) {
    assert.equal(declared.get(tool.name), tool.dependency, `${tool.name}: source literal differs from the registered metadata`);
  }
});

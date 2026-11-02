// T7:场景**读侧**能力与实例覆盖写入的校验(本文件不起引擎)。
//
//   1. scene_get_tree 的 connections:raw(文件原值/null)+ 语义位 + otherBits;
//   2. scene_get_tree 对 `[instance=...]` 节点的解析(isInstance / instanceScene / overrides,不展开子场景);
//   3. scene_get_node_info 的数据层:parseExtensionApi 解析、缓存按引擎版本键、引擎不可用时明确报错;
//   4. scene_update_node_property 在实例节点上的两条校验(只写当前文件的覆盖 + 字面量类型不符报错)。
//
// 真实引擎对照(功能 1/2 回读、功能 3 与 ClassDB 抽查)在 sceneReadTools.real.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { GodotMcpError } from "../src/core/errors.js";
import { createLogger } from "../src/core/logger.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import {
  buildDumpExtensionApiArgs,
  cacheKeyOf,
  DUMP_EXTENSION_API_FLAG,
  parseExtensionApi,
} from "../src/godot/api/extensionApi.js";
import { RUNTIME_FLAGS, type GodotRunRunner, type RunProcessResult } from "../src/godot/runtime/run.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { GodotApiService } from "../src/services/godotApiService.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { SceneService } from "../src/services/sceneService.js";
import { allTools } from "../src/tools/index.js";
import type { AppContext } from "../src/services/context.js";
import type { ToolResult } from "../src/types/index.js";

const REPO = path.join(import.meta.dirname!, "..", "..");
const FIXTURE_PROJECT = path.join(REPO, "tests", "fixture_project");
/** 真实引擎写出的场景(tests/fixtures/SOURCE.md 第六节):含 flags=3/3/6 的连接与一个子场景实例。 */
const ENGINE_SAVED = fs.readFileSync(path.join(REPO, "tests", "fixtures", "t6_engine_saved.tscn"), "utf8");
/** 引擎写出的真实工程场景:实例节点上有 script + hp 两个覆盖。 */
const SAMPLE_MAIN = fs.readFileSync(path.join(REPO, "tests", "fixtures", "sample_project", "main.tscn"), "utf8");

const quiet = createLogger("error", () => {});
const scene = new SceneService();

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: unknown }).data as Record<string, unknown>;
}

function err(r: ToolResult): { code: string; message: string; details?: Record<string, unknown> } {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }).error;
}

function isCode(code: string) {
  return (e: unknown): boolean => e instanceof GodotMcpError && e.code === code;
}

/** 每个用例把 fixture_project 整目录拷到临时目录再操作,仓库副本保持原样(T6 起的约定)。 */
function makeHost(t: { after: (fn: () => void) => void }): { dir: string; host: ToolHost<AppContext>; ctx: AppContext } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-t7-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE_PROJECT, dir, { recursive: true });
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet), ctx };
}

// ────────────────────── 1. scene_get_tree:connections ──────────────────────

test("connections: 引擎写出的场景 — raw 为文件原值(无 flags= 时为 null),语义位与 otherBits 由 raw 拆出", () => {
  const { connections } = scene.getSceneTree(ENGINE_SAVED);
  assert.deepEqual(
    connections.map((c) => [c.source, c.signal, c.target, c.method, c.flags.raw]),
    [
      ["Player", "ready", ".", "_on_ready", null],                 // 文件里没有 flags=
      ["Player", "tree_exited", ".", "_on_ready", null],
      ["Player", "tree_exiting", ".", "_on_ready", 3],             // flags=3
      ["Player", "visibility_changed", ".", "_on_ready", 3],
      ["Level", "tree_exited", ".", "_on_ready", 6],               // flags=6
    ],
  );
  assert.deepEqual(connections.map((c) => c.flags.semantic), [
    [], [], ["DEFERRED", "PERSIST"], ["DEFERRED", "PERSIST"], ["PERSIST", "ONE_SHOT"],
  ]);
  assert.deepEqual(connections.map((c) => c.flags.otherBits), [[], [], [], [], []]);

  // 语义位只解释**文件里真实写出的**位:与 raw 严格对应。
  // (引擎加载时另外并入 PERSIST|INHERITED=34 —— 那一步在 sceneReadTools.real.test.ts 里用真实引擎核对。)
  for (const c of connections) {
    const semanticMask = c.flags.semantic.reduce(
      (mask, name) => mask | ({ DEFERRED: 1, PERSIST: 2, ONE_SHOT: 4, REFERENCE_COUNTED: 8, APPEND_SOURCE_OBJECT: 16 })[name]!,
      0,
    );
    assert.equal(semanticMask, (c.flags.raw ?? 0) & ~32, `${c.signal} 的语义位与 raw 不一致`);
  }
});

test("connections: 命名位之外的位进 otherBits(含引擎隐含的 INHERITED=32),未知写法不被吞掉", () => {
  const text = '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n\n[node name="A" type="Node" parent="."]\n'
    + '[connection signal="s" from="A" to="." method="m" flags=49]\n';
  const [conn] = scene.getSceneTree(text).connections;
  assert.equal(conn?.flags.raw, 49); // 1 | 16 | 32
  assert.deepEqual(conn?.flags.semantic, ["DEFERRED", "APPEND_SOURCE_OBJECT"]);
  assert.deepEqual(conn?.flags.otherBits, [32]);
});

test("connections: 缺少必填字段或 flags 非法时抛 PARSE_ERROR,不静默丢连接", () => {
  const head = '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n';
  assert.throws(() => scene.getSceneTree(`${head}\n[connection signal="s" to="." method="m"]`), isCode("PARSE_ERROR"));
  assert.throws(() => scene.getSceneTree(`${head}\n[connection signal="s" from="." method="m"]`), isCode("PARSE_ERROR"));
  assert.throws(() => scene.getSceneTree(`${head}\n[connection signal="s" from="." to="." ]`), isCode("PARSE_ERROR"));
  assert.throws(() => scene.getSceneTree(`${head}\n[connection signal="s" from="." to="." method="m" flags=abc]`), isCode("PARSE_ERROR"));
  assert.throws(() => scene.getSceneTree(`${head}\n[connection signal="s" from="." to="." method="m" flags=3.5]`), isCode("PARSE_ERROR"));
  assert.throws(() => scene.getSceneTree(`${head}\n[connection signal="s" from="." to="." method="m" flags=-1]`), isCode("PARSE_ERROR"));
});

// ────────────────────── 2. scene_get_tree:[instance=...] ──────────────────────

test("实例节点: 引擎写出的场景 — isInstance/instanceScene 正确,且不展开子场景内部节点", () => {
  const tree = scene.getSceneTree(ENGINE_SAVED);
  const child = tree.nodes.find((n) => n.path === "Level/Child");
  assert.equal(child?.isInstance, true);
  assert.equal(child?.instanceScene, "res://scenes/child.tscn");
  assert.deepEqual(child?.overrides, []);
  assert.deepEqual(child?.children, [], "子场景内部节点不得被展开");
  assert.ok(!tree.nodes.some((n) => n.path === "Level/Child/Marker"), "子场景内部节点不得出现在本文件的树里");

  // 非实例节点:isInstance=false 且不出现 overrides
  const level = tree.nodes.find((n) => n.path === "Level");
  assert.equal(level?.isInstance, false);
  assert.equal(level?.overrides, undefined);
  assert.equal(level?.instanceScene, undefined);
});

test("实例节点: 覆盖属性 = 该节点段体属性(含 script),与 properties 同值", () => {
  const tree = scene.getSceneTree(SAMPLE_MAIN);
  const inst = tree.nodes.find((n) => n.name === "ChildInstance");
  assert.equal(inst?.isInstance, true);
  assert.equal(inst?.instanceScene, "res://child.tscn");
  assert.deepEqual(inst?.overrides, [
    { name: "script", value: 'ExtResource("3_lquwl")' },
    { name: "hp", value: "25" },
  ]);
  assert.deepEqual(inst?.overrides, inst?.properties);
  assert.equal(inst?.script, "res://child.gd"); // 已有的 script 解析行为不变
});

test("实例节点: instance 引用解析不到时 instanceScene 缺省,原文仍留在 instance(不猜)", () => {
  const text = '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n\n[node name="Ghost" type="Node" parent="." instance=ExtResource("9_none")]\n';
  const ghost = scene.getSceneTree(text).nodes.find((n) => n.path === "Ghost");
  assert.equal(ghost?.isInstance, true);
  assert.equal(ghost?.instanceScene, undefined);
  assert.equal(ghost?.instance, 'ExtResource("9_none")');
});

test("实例节点: instance_placeholder 也认作实例;直接写 res:// 路径时采用原文,别的写法不猜", () => {
  // 注:占位实例的写法本仓样例未覆盖(未经引擎实测),这里只断言"不猜"的边界:
  // 文本里明写着 res:// 就采用,写别的(例如解析不到的 ExtResource)就不给 instanceScene。
  const text = '[gd_scene format=3]\n\n[node name="Root" type="Node"]\n'
    + '\n[node name="Ph" type="Node" parent="." instance_placeholder="res://scenes/child.tscn"]\n'
    + '\n[node name="Odd" type="Node" parent="." instance_placeholder=ExtResource("9_none")]\n';
  const tree = scene.getSceneTree(text);
  assert.equal(tree.nodes.find((n) => n.path === "Ph")?.isInstance, true);
  assert.equal(tree.nodes.find((n) => n.path === "Ph")?.instanceScene, "res://scenes/child.tscn");
  assert.equal(tree.nodes.find((n) => n.path === "Odd")?.isInstance, true);
  assert.equal(tree.nodes.find((n) => n.path === "Odd")?.instanceScene, undefined);
});

// ────────────────────── 3a. 数据层:parseExtensionApi ──────────────────────

/** 手写的最小 dump(**我们的输入格式**,不是引擎行为断言):故意省掉 signals/enums/constants 键。 */
const MINI_API = {
  header: { version_full_name: "Godot Engine v9.9.9.stub" },
  global_enums: [{ name: "GlobalMode", is_bitfield: false, values: [{ name: "GLOBAL_A", value: 0 }] }],
  classes: [
    { name: "Object", is_refcounted: false, is_instantiable: false, api_type: "core", methods: [], properties: [] },
    { name: "Node", inherits: "Object", is_refcounted: false, is_instantiable: true, api_type: "core", methods: [], properties: [] },
    {
      name: "Node2D", inherits: "Node", is_refcounted: false, is_instantiable: true, api_type: "core",
      properties: [{ type: "Vector2", name: "position", setter: "set_position", getter: "get_position" }],
      methods: [{ name: "set_position", arguments: [{ name: "position", type: "Vector2" }] }],
    },
    {
      name: "Widget", inherits: "Node2D", is_refcounted: false, is_instantiable: true, api_type: "core",
      enums: [
        { name: "Mode", is_bitfield: false, values: [{ name: "MODE_A", value: 0 }, { name: "MODE_B", value: 1 }] },
        { name: "Flags", is_bitfield: true, values: [{ name: "FLAG_A", value: 1 }] },
      ],
      properties: [
        { type: "int", name: "mode", setter: "set_mode", getter: "get_mode" },             // enum::Widget.Mode
        { type: "int", name: "flags", setter: "set_flags", getter: "get_flags" },           // bitfield::Widget.Flags
        { type: "int", name: "global", setter: "set_global", getter: "get_global" },        // enum::GlobalMode(全局枚举)
        { type: "int", name: "plain", setter: "set_plain", getter: "get_plain" },           // 无枚举关联
        { type: "String", name: "label", getter: "get_label" },                             // 连 setter 都没有
        // 反例(4.6.3 的 Control.offset_left 就是这个形状):多参数 setter 的第一个参数是定位用的枚举,
        // 不是属性类型 → 不得据此声明枚举
        { type: "float", name: "offset_left", setter: "set_offset", getter: "get_offset" },
        { type: "int", name: "pair", setter: "set_pair", getter: "get_pair" },
      ],
      methods: [
        { name: "set_mode", arguments: [{ name: "mode", type: "enum::Widget.Mode" }] },
        { name: "set_flags", arguments: [{ name: "flags", type: "bitfield::Widget.Flags" }] },
        { name: "set_global", arguments: [{ name: "global", type: "enum::GlobalMode" }] },
        { name: "set_plain", arguments: [{ name: "plain", type: "int" }] },
        { name: "set_offset", arguments: [{ name: "side", type: "enum::Widget.Mode" }, { name: "offset", type: "float" }] },
        { name: "set_pair", arguments: [{ name: "mode", type: "enum::Widget.Mode" }, { name: "n", type: "int" }] },
      ],
      signals: [{ name: "changed" }, { name: "moved", arguments: [{ name: "delta", type: "Vector2" }] }],
    },
  ],
};

test("parseExtensionApi: 类/继承/属性类型/枚举关联/信号签名;缺键按空处理", () => {
  const api = parseExtensionApi(JSON.stringify(MINI_API));
  assert.equal(api.versionFullName, "Godot Engine v9.9.9.stub");
  assert.equal(api.classes.size, 4);

  const object = api.classes.get("Object");
  assert.equal(object?.inherits, undefined);            // Object 在 dump 里没有 inherits 键
  assert.deepEqual(object?.signals, []);                // 没有 signals 键 → 空数组
  assert.deepEqual(object?.enums, []);

  const widget = api.classes.get("Widget");
  assert.deepEqual(widget?.properties.map((p) => [p.name, p.type, p.enumName ?? null]), [
    ["mode", "int", "Widget.Mode"],          // 由 setter 参数 enum:: 推出
    ["flags", "int", "Widget.Flags"],        // 位域用 bitfield:: 前缀
    ["global", "int", "GlobalMode"],         // 无类名前缀 → 全局枚举
    ["plain", "int", null],                  // setter 参数不是枚举 → 不猜
    ["label", "String", null],               // 没有 setter → 不猜
    ["offset_left", "float", null],          // 多参数 setter + 非 int 属性 → 不认(反例)
    ["pair", "int", null],                   // 多参数 setter → 不认(哪怕第一个参数是枚举)
  ]);
  assert.deepEqual(widget?.signals, [
    { name: "changed", arguments: [] },                                          // 无参信号没有 arguments 键
    { name: "moved", arguments: [{ name: "delta", type: "Vector2" }] },
  ]);
  assert.deepEqual(widget?.methods.find((m) => m.name === "set_mode"), { name: "set_mode", arguments: [{ name: "mode", type: "enum::Widget.Mode" }], isStatic: false, isVararg: false });
  assert.deepEqual(widget?.properties.find((p) => p.name === "mode")?.getter, "get_mode");
  assert.deepEqual(api.globalEnums.get("GlobalMode")?.values, [{ name: "GLOBAL_A", value: 0 }]);
});

test("parseExtensionApi: 结构不合法时抛 PARSE_ERROR(缓存损坏靠它识别)", () => {
  assert.throws(() => parseExtensionApi("{not json"), isCode("PARSE_ERROR"));
  assert.throws(() => parseExtensionApi("{}"), isCode("PARSE_ERROR"));
  assert.throws(() => parseExtensionApi('{"classes": []}'), isCode("PARSE_ERROR"));
});

test("buildDumpExtensionApiArgs: 只用有据可查的标志(都在 RUNTIME_FLAGS 与 4.6.3 --help 里)", () => {
  const args = buildDumpExtensionApiArgs();
  assert.deepEqual(args, ["--headless", DUMP_EXTENSION_API_FLAG]);
  for (const flag of args) assert.ok(RUNTIME_FLAGS.includes(flag), `${flag} 未登记在 RUNTIME_FLAGS`);
  const help = fs.readFileSync(path.join(REPO, "tests", "fixtures", "godot-help.txt"), "utf8");
  for (const flag of args) assert.ok(help.includes(flag), `${flag} 未出现在 4.6.3 --help 记录里`);
  assert.equal(cacheKeyOf("4.6.3.stable.official.7d41c59c4\n"), "4.6.3.stable.official.7d41c59c4");
  assert.equal(cacheKeyOf("  "), "unknown");
  assert.ok(!cacheKeyOf("../evil/../x").includes("/"), "版本键必须清洗成安全文件名");
});

// ────────────────────── 3b. 服务层:缓存与降级(注入替身) ──────────────────────

const STUB_VERSION_RAW = "9.9.9.stub.official.deadbeef\n";
const STUB_CACHE_KEY = "9.9.9.stub.official.deadbeef";

function runResult(over: Partial<RunProcessResult> = {}): RunProcessResult {
  return {
    exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 1, ...over,
  };
}

interface StubOptions {
  /** dump 伪造产物写盘前的内容;默认写最小 dump。 */
  dump?: string;
  exitCode?: number;
  writeFile?: boolean;
  env?: NodeJS.ProcessEnv;
}

function makeStubService(dir: string, o: StubOptions = {}): { service: GodotApiService; calls: Array<{ args: readonly string[]; cwd?: string }> } {
  const fakeExe = path.join(dir, "fake-godot.exe");
  fs.writeFileSync(fakeExe, "");
  const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
  const dumpRunner: GodotRunRunner = (_file, args, opts) => {
    calls.push({ args, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) });
    if (o.writeFile !== false && opts.cwd !== undefined) {
      fs.writeFileSync(path.join(opts.cwd, "extension_api.json"), o.dump ?? JSON.stringify(MINI_API));
    }
    return Promise.resolve(runResult({ exitCode: o.exitCode ?? 0 }));
  };
  const godot = new GodotCliService({
    env: o.env ?? { GODOT_PATH: fakeExe },
    runner: () => Promise.resolve({ stdout: STUB_VERSION_RAW, stderr: "" }),
  });
  const project = new ProjectResolver({ cwd: dir });
  const runQueue = new TaskQueue(new LockManager());
  return { service: new GodotApiService({ godot, project, runQueue, runner: dumpRunner }), calls };
}

test("scene_get_node_info 服务层: 引擎不可用时 GODOT_NOT_FOUND,并说明为什么需要引擎", async (t) => {
  const { dir } = makeHost(t);
  const { service } = makeStubService(dir, { env: {} }); // GODOT_PATH 未设置 + PATH 无候选
  const e = await service.getClassInfo(undefined, "Node2D").then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof GodotMcpError);
  assert.equal(e.code, "GODOT_NOT_FOUND");
  assert.match(e.message, /GODOT_PATH/);
  assert.equal(e.details?.["godotPath"], null);
  assert.equal(e.details?.["requiredFor"], "ClassDB API dump (extension_api.json)");
  assert.ok(!fs.existsSync(path.join(dir, ".vino-godot-mcp")), "引擎不可用时不得留下缓存目录");
});

test("scene_get_node_info 服务层: 冷启动 dump 到 <工程根>/.vino-godot-mcp/extension-api/<版本>.json,之后命中缓存", async (t) => {
  const { dir } = makeHost(t);
  const { service, calls } = makeStubService(dir);
  const info = await service.getClassInfo(undefined, "Widget");

  assert.equal(info.nodeType, "Widget");
  assert.deepEqual(info.inheritance, ["Node2D", "Node", "Object"]);
  assert.equal(info.isInstantiable, true);
  assert.equal(info.apiType, "core");
  assert.equal(info.source.fromCache, false);
  assert.equal(info.source.engineVersion, STUB_CACHE_KEY);
  assert.equal(info.source.apiVersionFullName, "Godot Engine v9.9.9.stub");
  assert.deepEqual(info.properties.map((p) => [p.name, p.enum?.name ?? null]), [
    ["mode", "Mode"], ["flags", "Flags"], ["global", "GlobalMode"], ["plain", null], ["label", null],
    ["offset_left", null], ["pair", null], // 多参数 setter 的反例不认
  ]);
  assert.deepEqual(info.properties[0]?.enum?.values, [{ name: "MODE_A", value: 0 }, { name: "MODE_B", value: 1 }]);
  assert.equal(info.properties[1]?.enum?.isBitfield, true);
  // `enum::GlobalMode` 没有类名前缀 → 到 global_enums 里取(4.6.3 实测 Error/Side 这类就是这样)
  assert.deepEqual(info.properties[2]?.enum?.values, [{ name: "GLOBAL_A", value: 0 }]);

  const cacheFile = path.join(dir, ".vino-godot-mcp", "extension-api", `${STUB_CACHE_KEY}.json`);
  assert.equal(info.source.cacheFile, cacheFile);
  assert.ok(fs.existsSync(cacheFile), "dump 产物应被 rename 成缓存文件");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["--headless", "--dump-extension-api"]);
  assert.equal(calls[0]?.cwd, path.dirname(cacheFile), "dump 必须在缓存目录里跑(--dump-extension-api 写进程 cwd)");
  assert.ok(!fs.existsSync(path.join(path.dirname(cacheFile), "extension_api.json")), "中间产物不应留下");

  const again = await service.getClassInfo(undefined, "Widget");
  assert.equal(again.source.fromCache, true);
  assert.equal(calls.length, 1, "第二次调用不得再起引擎");
});

test("scene_get_node_info 服务层: 缓存损坏 → 删除并重新 dump;dump 失败 → GODOT_PROCESS_FAILED 带日志", async (t) => {
  const { dir } = makeHost(t);
  const { service, calls } = makeStubService(dir);
  const cacheDir = path.join(dir, ".vino-godot-mcp", "extension-api");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `${STUB_CACHE_KEY}.json`);
  fs.writeFileSync(cacheFile, '{"classes": [{"name":'); // 被截断的缓存
  const info = await service.getClassInfo(undefined, "Widget");
  assert.equal(info.source.fromCache, false);
  assert.equal(calls.length, 1, "损坏的缓存应触发一次重新 dump");
  assert.ok(fs.readFileSync(cacheFile, "utf8").length > 100);

  const { dir: dir2 } = makeHost(t);
  const { service: failing } = makeStubService(dir2, { exitCode: 3, writeFile: false });
  const e = await failing.getClassInfo(undefined, "Node2D").then(() => undefined, (x: unknown) => x);
  assert.ok(e instanceof GodotMcpError && e.code === "GODOT_PROCESS_FAILED", String(e));
  assert.equal((e as GodotMcpError).details?.["exitCode"], 3);

  const { dir: dir3 } = makeHost(t);
  const { service: silent } = makeStubService(dir3, { writeFile: false });
  const missing = await silent.getClassInfo(undefined, "Node2D").then(() => undefined, (x: unknown) => x);
  assert.ok(missing instanceof GodotMcpError && missing.code === "GODOT_PROCESS_FAILED", String(missing));
  assert.match(missing.message, /wrote no extension_api\.json/);
});

test("scene_get_node_info: 未知类名 / 空 nodeType 明确报错;参数校验照旧", async (t) => {
  const { dir, host, ctx } = makeHost(t);
  ctx.godotApi = makeStubService(dir).service;

  assert.equal(err(await host.callTool("scene_get_node_info", { nodeType: "NoSuchClass" })).code, "INVALID_ARGUMENT");
  assert.match(err(await host.callTool("scene_get_node_info", { nodeType: "NoSuchClass" })).message, /ClassDB/);
  assert.equal(err(await host.callTool("scene_get_node_info", { nodeType: "  " })).code, "INVALID_ARGUMENT");
  assert.equal(err(await host.callTool("scene_get_node_info", { nodeType: "Node2D", bogus: 1 })).code, "INVALID_ARGUMENT");
  // 缺必填参数由 schema 校验拦下
  assert.equal(err(await host.callTool("scene_get_node_info", {})).code, "INVALID_ARGUMENT");

  const data = ok(await host.callTool("scene_get_node_info", { nodeType: "Widget" }));
  assert.equal(data["nodeType"], "Widget");
});

// ────────────────────── 4. 实例节点的覆盖写入 ──────────────────────

/** 在用例的临时工程里实例化 child.tscn(名为 Child),供覆盖写入用例使用。 */
async function instantiateChild(host: ToolHost<AppContext>): Promise<void> {
  const r = await host.callTool("scene_instantiate_scene", {
    path: "res://scenes/main.tscn", parentPath: ".", instanceScenePath: "res://scenes/child.tscn",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
}

test("实例覆盖: 只有实例节点做类型校验;新增覆盖与同类型写入都放行", async (t) => {
  const { dir, host } = makeHost(t);
  await instantiateChild(host);
  const scenePath = "res://scenes/main.tscn";
  const childFile = path.join(dir, "scenes", "child.tscn");
  const childBefore = fs.readFileSync(childFile, "utf8");

  // 新增覆盖(本节点原先没有该属性):不猜、直接写
  const added = ok(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Child", key: "position", value: "Vector2(3, 4)" }));
  assert.equal(added["changed"], true);
  // 同类型(以及 int↔float 这类引擎会隐式转换的)继续放行
  ok(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Child", key: "position", value: "Vector2(5, 6)" }));
  ok(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Child", key: "z_index", value: "7" }));
  ok(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Child", key: "z_index", value: "7.5" }));

  const tree = ok(await host.callTool("scene_get_tree", { path: scenePath }));
  const child = (tree["tree"] as { nodes: Array<{ path: string; overrides?: Array<{ name: string; value: string }> }> })
    .nodes.find((n) => n.path === "Child");
  assert.deepEqual(child?.overrides, [
    { name: "position", value: "Vector2(5, 6)" },
    { name: "z_index", value: "7.5" },
  ]);
  // 覆盖写在当前场景文件里,原子场景文件逐字节未变
  assert.equal(fs.readFileSync(childFile, "utf8"), childBefore);
  assert.match(fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8"), /\[node name="Child" type="Node2D" parent="\." instance=ExtResource\("3_mcp"\)\]/);
});

test("实例覆盖: 值类型与现有覆盖明显不符时报错(判据仅限字面量),不静默写入", async (t) => {
  const { dir, host } = makeHost(t);
  await instantiateChild(host);
  const scenePath = "res://scenes/main.tscn";
  ok(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Child", key: "position", value: "Vector2(3, 4)" }));
  ok(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Child", key: "visible", value: "true" }));

  const mismatch = err(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Child", key: "position", value: "Vector3(1, 2, 3)" }));
  assert.equal(mismatch.code, "INVALID_ARGUMENT");
  assert.equal(mismatch.details?.["existingType"], "Vector2");
  assert.equal(mismatch.details?.["newType"], "Vector3");

  const boolMismatch = err(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Child", key: "visible", value: '"yes"' }));
  assert.equal(boolMismatch.code, "INVALID_ARGUMENT");
  assert.equal(boolMismatch.details?.["existingType"], "bool");
  assert.equal(boolMismatch.details?.["newType"], "String");

  // 被拒绝的写入没有落盘
  const text = fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8");
  assert.ok(text.includes("position = Vector2(3, 4)"));
  assert.ok(!text.includes("Vector3"));

  // 非实例节点不受影响:类型"不符"也照写(本轮按裁决只对实例节点加校验)
  ok(await host.callTool("scene_update_node_property", { path: scenePath, nodePath: "Player", key: "position", value: "Vector3(1, 2, 3)" }));
});

test("实例覆盖: 指向子场景内部的路径给出明确原因,而不是裸的'节点不存在'", async (t) => {
  const { dir, host } = makeHost(t);
  await instantiateChild(host);
  const e = err(await host.callTool("scene_update_node_property", {
    path: "res://scenes/main.tscn", nodePath: "Child/Marker", key: "position", value: "Vector2(1, 2)",
  }));
  assert.equal(e.code, "INVALID_ARGUMENT");
  assert.match(e.message, /被实例化的子场景/);
  assert.equal(e.details?.["instantiatedAncestor"], "Child");
  assert.equal(e.details?.["instanceScene"], "res://scenes/child.tscn");
  assert.ok(fs.readFileSync(path.join(dir, "scenes", "child.tscn"), "utf8").includes('[node name="Marker" type="Marker2D" parent="."]'));
});

// T7:用真实 Godot 4.6.3 把读侧结果与**引擎自身**对齐。
//
//   1) scene_get_node_info vs ClassDB:抽查 5 个类(Node2D / CharacterBody2D / Sprite2D / Control /
//      AnimationPlayer)的继承链、自身属性(name+type)、信号签名、枚举成员名称与数值;
//   2) scene_get_tree 的 connections/实例 vs 引擎真实加载一个**引擎自己写出**的场景
//      (tests/fixtures/t6_engine_saved.tscn):"文件原值 | 34" 应等于引擎读回的 flags,实例节点的
//      instanceScene 应等于引擎的 scene_file_path,且子场景内部节点不得被展开进本文件。
//
// 约定:真实测试只读环境变量 GODOT_BIN(测试运行时临时设置,授权路径),未设置则整组 skip。
// 所有产物(引擎 .godot/ 缓存、`.vino-godot-mcp/` API dump 缓存)都落在 mkdtemp 出来的临时目录里。
// 调试用逃生口:T7_KEEP=1 时保留临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { defaultRunRunner } from "../src/godot/runtime/run.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { GodotApiService } from "../src/services/godotApiService.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { allTools } from "../src/tools/index.js";
import type { AppContext } from "../src/services/context.js";
import type { SceneConnection, SceneNode } from "../src/services/sceneService.js";
import type { ToolResult } from "../src/types/index.js";

const FIXTURE_PROJECT = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");
const FIXTURES = path.join(import.meta.dirname!, "..", "..", "tests", "fixtures");
const VERIFY_GD = path.join(FIXTURES, "t7_verify.gd");
const ENGINE_SAVED_TS = path.join(FIXTURES, "t6_engine_saved.tscn");
const GODOT_BIN = process.env["GODOT_BIN"];
const TIMEOUT_MS = 60_000;
const SCENE = "res://scenes/engine_saved.tscn";
const CLASSES = ["Node2D", "CharacterBody2D", "Sprite2D", "Control", "AnimationPlayer"];
/** 引擎加载 .tscn 的连接时并入的隐含位:CONNECT_PERSIST(2)|CONNECT_INHERITED(32)(T6.5 实测)。 */
const LOADER_BASE_FLAGS = 34;
const FLAG_BITS: Record<string, number> = { DEFERRED: 1, PERSIST: 2, ONE_SHOT: 4, REFERENCE_COUNTED: 8, APPEND_SOURCE_OBJECT: 16 };

const quiet = createLogger("error", () => {});
const skip = GODOT_BIN ? false : "GODOT_BIN 未设置";

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: unknown }).data as Record<string, unknown>;
}

interface Harness { dir: string; host: ToolHost<AppContext> }

function makeHarness(t: { after: (fn: () => void) => void }): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-t7-real-"));
  t.after(() => {
    if (process.env["T7_KEEP"] === "1") {
      console.log(`T7 temp dir kept: ${dir}`);
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.cpSync(FIXTURE_PROJECT, dir, { recursive: true });
  fs.copyFileSync(VERIFY_GD, path.join(dir, "t7_verify.gd"));
  fs.copyFileSync(ENGINE_SAVED_TS, path.join(dir, "scenes", "engine_saved.tscn"));

  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  // 引擎只从 GODOT_PATH 定位(见 src/godot/cli.ts);这里把授权的 GODOT_BIN 临时喂给它(不写进任何配置)。
  const env = { ...process.env, GODOT_PATH: GODOT_BIN! };
  ctx.godotApi = new GodotApiService({ godot: new GodotCliService({ env }), project: ctx.project, runQueue: ctx.runQueue, env });
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

interface EngineRun { lines: string[]; exitCode: number | null; output: string }

async function runVerify(dir: string): Promise<EngineRun> {
  const res = await defaultRunRunner(
    GODOT_BIN!,
    ["--headless", "--path", dir, "--script", path.join(dir, "t7_verify.gd"), "--", "--scene", SCENE],
    { timeoutMs: TIMEOUT_MS },
  );
  const output = `${res.stdout}\n${res.stderr}`;
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.startsWith("T7RESULT ")).map((l) => l.slice("T7RESULT ".length));
  return { lines, exitCode: res.exitCode, output };
}

function assertEngineRan(run: EngineRun): void {
  const noisy = run.output.split(/\r?\n/).filter((l) => /\bSCRIPT ERROR\b|^\s*ERROR:/.test(l));
  assert.deepEqual(noisy, [], `Godot 报错:\n${noisy.join("\n")}`);
  assert.equal(run.exitCode, 0, `Godot 退出码非 0\n${run.output}`);
  assert.ok(run.lines.includes("ok"), `验证脚本未跑完:\n${run.output}`);
}

interface EngineClass {
  chain: string[];
  instantiable: boolean;
  props: Map<string, string>;
  hints: Map<string, string>;
  sigs: string[];
  consts: Map<string, number>;
}

/** `T7RESULT` 行 → 按类聚合的引擎事实。 */
function engineClasses(lines: string[]): Map<string, EngineClass> {
  const byClass = new Map<string, EngineClass>();
  const get = (name: string): EngineClass => {
    let c = byClass.get(name);
    if (!c) {
      c = { chain: [], instantiable: false, props: new Map(), hints: new Map(), sigs: [], consts: new Map() };
      byClass.set(name, c);
    }
    return c;
  };
  for (const line of lines) {
    const f = line.split("|");
    const cls = f[1];
    if (cls === undefined) continue;
    if (f[0] === "class") {
      const kv = Object.fromEntries(f.slice(2).map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
      get(cls).instantiable = kv["instantiable"] === "true";
    } else if (f[0] === "chain") {
      get(cls).chain = (f[2] ?? "").split(",").filter((s) => s !== "");
    } else if (f[0] === "prop") {
      get(cls).props.set(f[2]!, f[3] ?? "");
    } else if (f[0] === "hint") {
      get(cls).hints.set(f[2]!, f[3] ?? "");
    } else if (f[0] === "sig") {
      get(cls).sigs.push(`${f[2]}|${f[3] ?? ""}`);
    } else if (f[0] === "const") {
      get(cls).consts.set(f[2]!, Number(f[3]));
    }
  }
  return byClass;
}

test("real: scene_get_node_info 的继承链/属性/信号/枚举与引擎 ClassDB 逐项一致", { skip }, async (t) => {
  const { dir, host } = makeHarness(t);
  const run = await runVerify(dir);
  assertEngineRan(run);
  const engine = engineClasses(run.lines);

  const enumDiagnostics: string[] = [];
  for (const cls of CLASSES) {
    const facts = engine.get(cls);
    assert.ok(facts, `验证脚本没有输出 ${cls} 的 ClassDB 信息`);
    const info = ok(await host.callTool("scene_get_node_info", { nodeType: cls }));
    assert.equal(info["nodeType"], cls);
    assert.equal(info["apiType"], "core");
    assert.equal(info["isInstantiable"], facts.instantiable, `${cls} isInstantiable`);

    // ① 继承链:与引擎逐级 get_parent_class 的结果完全一致
    const chain = (info["inheritance"] as string[]).join(">");
    assert.equal(chain, facts.chain.join(">"), `${cls} 继承链`);

    // ② 属性:我们报的每一条都必须被引擎确认(名称+类型),且不得多报;
    //    引擎侧多出来的只允许是 `_get_property_list` 加的编辑器伪属性(type 为 Nil,如 Node2D 的 "Transform")
    //    —— 这类属性不在 GDExtension 的 extension_api.json 里,故两边不可能真正同集。
    const ourProps = new Map((info["properties"] as Array<{ name: string; type: string }>).map((p) => [p.name, p.type]));
    for (const [name, type] of facts.props) {
      const mine = ourProps.get(name);
      if (mine !== undefined) assert.equal(mine, type, `${cls}.${name} 类型`);
    }
    const onlyOurs = [...ourProps].filter(([name]) => !facts.props.has(name)).map(([name, type]) => `${name}:${type}`);
    assert.deepEqual(onlyOurs, [], `${cls} 我们多报的属性`);
    const onlyEngine = [...facts.props].filter(([name]) => !ourProps.has(name)).map(([name, type]) => `${name}:${type}`);
    assert.deepEqual(onlyEngine.filter((p) => !p.endsWith(":Nil")), [], `${cls} 出现未解释的引擎侧额外属性`);
    if (onlyEngine.length > 0) console.log(`--- ${cls} 仅引擎侧(编辑器伪属性,不在 API dump 里)---\n${onlyEngine.join("\n")}`);

    // ③ 信号:名称 + 参数签名完全一致(无参信号引擎侧也是空参数表)
    const ourSignals = (info["signals"] as Array<{ name: string; arguments: Array<{ name: string; type: string }> }>)
      .map((s) => `${s.name}|${s.arguments.map((a) => `${a.name}:${a.type}`).join(",")}`).sort();
    assert.deepEqual(ourSignals, [...facts.sigs].sort(), `${cls} 信号列表`);

    // ④ 枚举:属性上的枚举成员必须能被引擎确认。
    //    - 类内枚举:成员名 + 数值都对照 ClassDB 的整数常量(逐条精确);
    //    - 全局枚举(Side/Corner 这种,不在 ClassDB 的类常量表里):核对该属性 hint_string 的名目数
    //      (位域枚举的 hint_string 只列标记,不列组合值,故位域只要求非空)。
    for (const p of info["properties"] as Array<{ name: string; type: string; enum?: { name: string; isBitfield: boolean; values: Array<{ name: string; value: number }> } }>) {
      if (!p.enum) continue;
      const hint: string = facts.hints.get(p.name) ?? "";
      assert.ok(hint !== "", `${cls}.${p.name} 我们标了枚举,但引擎没给它 hint_string`);
      let globalMembers = 0;
      for (const v of p.enum.values) {
        const engineValue: number | undefined = facts.consts.get(v.name);
        if (engineValue === undefined) { globalMembers++; continue; }
        assert.equal(engineValue, v.value, `${cls}.${p.name} 的枚举成员 ${v.name}`);
      }
      if (globalMembers > 0 && !p.enum.isBitfield) {
        assert.equal(hint.split(",").length, p.enum.values.length, `${cls}.${p.name} 全局枚举的可选值个数`);
      }
      enumDiagnostics.push(`${cls}.${p.name} → 我们 ${p.enum.values.length} 个值 [${p.enum.values.map((v) => v.name).join(",")}]; 引擎 hint_string="${hint}"`);
    }
  }
  console.log(`--- T7 枚举对照(诊断用)---\n${enumDiagnostics.join("\n")}`);

  // 第二次调用命中缓存:不再起引擎(scene_get_node_info 的缓存设计)
  const cached = ok(await host.callTool("scene_get_node_info", { nodeType: "Sprite2D" }));
  assert.equal((cached["source"] as { fromCache: boolean }).fromCache, true);
  const cacheFile = (cached["source"] as { cacheFile: string }).cacheFile;
  assert.ok(cacheFile.startsWith(path.join(dir, ".vino-godot-mcp", "extension-api")), cacheFile);
  assert.ok(fs.existsSync(cacheFile), `缓存文件不存在: ${cacheFile}`);
  assert.ok(fs.readFileSync(cacheFile, "utf8").length > 1_000_000, "缓存文件应是引擎原始 dump(数 MB)");
});

test("real: scene_get_tree 的 connections/实例与引擎加载结果一致(flags 互逆、实例不展开)", { skip }, async (t) => {
  const { dir, host } = makeHarness(t);
  const run = await runVerify(dir);
  assertEngineRan(run);

  const tree = ok(await host.callTool("scene_get_tree", { path: SCENE }))["tree"] as { nodes: SceneNode[]; connections: SceneConnection[] };
  assert.equal(tree.connections.length, 5);

  // ① 连接的四个字段与引擎读回一致;flags 的关系由引擎加载规则决定(本次真实复核 + T6.5):
  //      引擎读回 = (文件原值 & ~PERSIST) | PERSIST | INHERITED = (文件原值 & ~2) | 34
  //    即 PERSIST 被规范化掉(它是 .tscn 连接的隐含义)、INHERITED 被并入。
  //    所以"文件里的非隐含位"必须原样回得来:`raw & ~2 == 引擎读回 & ~34`。
  const engineConns = run.lines.filter((l) => l.startsWith("conn|")).map((l) => {
    const [, from, signal, to, method, flags] = l.split("|");
    return { from: from!, signal: signal!, to: to!, method: method!, flags: Number(flags) };
  });
  assert.equal(engineConns.length, tree.connections.length, "引擎读到的连接数与文件里的 [connection] 数不一致");
  for (const e of engineConns) {
    const mine = tree.connections.find((c) => c.source === e.from && c.signal === e.signal && c.target === e.to && c.method === e.method);
    assert.ok(mine, `文件里没有与引擎一致的连接 ${e.from}.${e.signal} -> ${e.to}.${e.method}`);
    const raw = mine.flags.raw ?? 0;
    assert.equal(e.flags, (raw & ~2) | LOADER_BASE_FLAGS, `${e.from}.${e.signal} 的 flags 与 raw 不互逆`);
    const semanticMask = mine.flags.semantic.reduce((mask, name) => mask | FLAG_BITS[name]!, 0);
    assert.equal(semanticMask & ~2, e.flags & ~LOADER_BASE_FLAGS, `${e.from}.${e.signal} 的非隐含位`);
    assert.deepEqual(mine.flags.otherBits, [], `${e.from}.${e.signal} 不应有未命名位`);
    // 我们读出的语义位与文件原值严格对应(raw 没写 PERSIST 时就不该报 PERSIST)
    assert.equal(semanticMask, raw & ~32, `${e.from}.${e.signal} 的语义位应等于文件原值去掉 32`);
  }

  // ② 实例:引擎的 scene_file_path 与我们的 instanceScene 一致(场景根自身的 scene_file_path 不算实例)
  const engineInstances = run.lines.filter((l) => l.startsWith("inst|")).map((l) => l.split("|"))
    .filter((f) => f[1] !== ".").map((f) => ({ nodePath: f[1]!, scenePath: f[2]! }));
  assert.deepEqual(engineInstances, [{ nodePath: "Level/Child", scenePath: "res://scenes/child.tscn" }]);
  for (const inst of engineInstances) {
    const mine = tree.nodes.find((n) => n.path === inst.nodePath);
    assert.equal(mine?.isInstance, true, `${inst.nodePath} 未被识别为实例`);
    assert.equal(mine?.instanceScene, inst.scenePath, `${inst.nodePath} 的 instanceScene`);
  }
  assert.equal(tree.nodes.find((n) => n.path === "Level/Child")?.children.length, 0);

  // ③ 我们读出的每个节点在引擎里都存在,type 也对得上;子场景内部节点不出现,但引擎那边有
  const engineNodes = new Map(run.lines.filter((l) => l.startsWith("node|")).map((l) => { const f = l.split("|"); return [f[1]!, f[2]!] as const; }));
  for (const n of tree.nodes) {
    assert.ok(engineNodes.has(n.path), `引擎的节点树里没有 ${n.path}`);
    if (n.type !== undefined) assert.equal(engineNodes.get(n.path), n.type, `${n.path} 的 type`);
  }
  assert.ok(engineNodes.has("Level/Child/Marker"), "引擎侧应展开子场景内部节点");
  assert.ok(!tree.nodes.some((n) => n.path === "Level/Child/Marker"), "我们的文本读取不得展开子场景内部节点");
});

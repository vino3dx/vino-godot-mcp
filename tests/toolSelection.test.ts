// P1-C: 工具暴露策略(preset ∩ group)。
//
// 分三层验证:
//   1) 纯策略层 selectTools/resolveToolSelection(allTools 真实数据)
//   2) 组合根 buildHost:注册结果与 callTool 可见性
//   3) 真实 MCP server 子进程:tools/list 与注册结果一致(证明筛选发生在注册之前)
//
// 断言不写死工具清单:期望值一律由 allTools + TOOL_PRESET_DEPENDENCIES 现算,
// 只把"当前基线数量"(40/57/45/62)作为审计锚点。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { createLogger } from "../src/core/logger.js";
import { GodotMcpError } from "../src/core/errors.js";
import { buildHost } from "../src/index.js";
import { allTools } from "../src/tools/index.js";
import {
  GROUPS_ENV,
  PRESET_ENV,
  TOOL_PRESET_DEPENDENCIES,
  parseToolGroups,
  parseToolPreset,
  resolveToolSelection,
} from "../src/mcp/registry/toolSelection.js";
import type { ToolDefinition, ToolDependency, ToolDomain } from "../src/types/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(HERE, "../src/index.js");
const quiet = createLogger("error", () => {});

const namesOf = (tools: readonly ToolDefinition[]) => tools.map((tool) => tool.name).sort();
const expectedFor = (dependencies: readonly ToolDependency[], domains: readonly ToolDomain[] = []) =>
  namesOf(allTools.filter((tool) => dependencies.includes(tool.dependency) && (domains.length === 0 || domains.includes(tool.domain))));
const selection = (env: Record<string, string | undefined>) => resolveToolSelection(allTools, env);

/** assert.throws 不返回错误对象,这里显式取回以便断言 code/details。 */
function catchError(run: () => unknown): GodotMcpError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof GodotMcpError, `expected GodotMcpError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the selection to fail, but it succeeded");
}

// ---------------------------------------------------------------- 预设本身

test("four presets expose exactly their declared dependencies (baseline 40 / 57 / 45 / 62)", () => {
  const baseline: Record<string, number> = { default: 40, runtime: 57, editor: 45, full: 62 };
  for (const [preset, count] of Object.entries(baseline)) {
    const sel = selection({ [PRESET_ENV]: preset });
    assert.equal(sel.preset, preset);
    assert.equal(sel.tools.length, count, `${preset} must expose ${count} tools`);
    // 成员必须与"dependency 集合"完全一致,数量对但成员错也算失败。
    assert.deepEqual(namesOf(sel.tools), expectedFor(TOOL_PRESET_DEPENDENCIES[preset as keyof typeof TOOL_PRESET_DEPENDENCIES]), `${preset} membership`);
  }
  // default 只含 none;runtime 加入 godot 但不含 bridge;editor 反之;full 全含。
  assert.deepEqual([...new Set(selection({ [PRESET_ENV]: "default" }).tools.map((t) => t.dependency))], ["none"]);
  assert.deepEqual([...new Set(selection({ [PRESET_ENV]: "runtime" }).tools.map((t) => t.dependency))].sort(), ["godot", "none"]);
  assert.deepEqual([...new Set(selection({ [PRESET_ENV]: "editor" }).tools.map((t) => t.dependency))].sort(), ["bridge", "none"]);
  assert.deepEqual([...new Set(selection({ [PRESET_ENV]: "full" }).tools.map((t) => t.dependency))].sort(), ["bridge", "godot", "none"]);
});

test("no configuration falls back to preset=default with no group filtering", () => {
  const sel = selection({});
  assert.equal(sel.preset, "default");
  assert.equal(sel.presetSource, "default");
  assert.equal(sel.domains.size, 0);
  assert.equal(sel.tools.length, 40);
  // 空字符串与纯空白同样视为未配置
  assert.equal(parseToolPreset("   "), "default");
  assert.equal(selection({ [PRESET_ENV]: "  ", [GROUPS_ENV]: " , " }).tools.length, 40);
  assert.equal(selection({ [PRESET_ENV]: "  ", [GROUPS_ENV]: " , " }).presetSource, "default");
});

test("preset names are case-insensitive but unknown names are rejected", () => {
  assert.equal(parseToolPreset("RUNTIME"), "runtime");
  const error = catchError(() => parseToolPreset("runtme"));
  assert.equal(error.code, "INVALID_CONFIGURATION");
  assert.match(error.message, /runtme/);
  assert.deepEqual((error.details as { validPresets: string[] }).validPresets, ["default", "runtime", "editor", "full"]);
});

test("group names are trimmed and lowercased like presets", () => {
  const known = new Set<ToolDomain>(allTools.map((tool) => tool.domain));
  assert.deepEqual([...parseToolGroups("  Scene , SHADER ", known)].sort(), ["scene", "shader"]);
  assert.deepEqual([...parseToolGroups("Scene,scene", known)], ["scene"], "deduped after normalisation");
  // 与显式预设组合时同样生效(大小写不再影响结果)
  const sel = selection({ [PRESET_ENV]: "full", [GROUPS_ENV]: " SCENE , Shader " });
  assert.equal(sel.tools.length, 19, "17 scene + 2 shader");
});

// ---------------------------------------------------------------- 兼容规则(4 种组合)

test("compatibility matrix: unset / groups-only / preset-only / both", () => {
  // 1) 两个都没配置 → default
  const none = selection({});
  assert.equal(none.preset, "default");
  assert.equal(none.presetSource, "default");
  assert.equal(none.tools.length, 40);

  // 2) 只配置 GROUPS → 不做 dependency 过滤(旧行为)
  const legacy = selection({ [GROUPS_ENV]: "project,shader" });
  assert.equal(legacy.preset, "full");
  assert.equal(legacy.presetSource, "legacy-groups");
  assert.equal(legacy.tools.length, 11, "9 project + 2 shader, exactly the pre-P1-C result");

  // 3) 只配置 PRESET → 严格按预设
  const presetOnly = selection({ [PRESET_ENV]: "runtime" });
  assert.equal(presetOnly.presetSource, "env");
  assert.equal(presetOnly.tools.length, 57);

  // 4) 两者都配置 → 交集
  const both = selection({ [PRESET_ENV]: "runtime", [GROUPS_ENV]: "scene,script,utility" });
  assert.equal(both.presetSource, "env");
  assert.equal(both.tools.length, 26);
});


// ---------------------------------------------------------------- preset ∩ group

test("preset and group intersect: a group narrows the preset and never widens it", () => {
  const sel = selection({ [PRESET_ENV]: "runtime", [GROUPS_ENV]: "scene,editor" });
  assert.equal(sel.domains.size, 2);
  // editor 域全是 bridge,被 runtime 预设排除;scene 只保留 none + godot。
  assert.deepEqual(namesOf(sel.tools), expectedFor(TOOL_PRESET_DEPENDENCIES.runtime, ["scene"]));
  assert.equal(sel.tools.some((tool) => tool.domain === "editor"), false);
  assert.equal(sel.tools.length, 17, "16 file-level scene tools + scene_get_node_info");

  // 同一组 group 在 editor 预设下结果完全不同
  const editor = selection({ [PRESET_ENV]: "editor", [GROUPS_ENV]: "scene,editor" });
  assert.deepEqual(namesOf(editor.tools), expectedFor(TOOL_PRESET_DEPENDENCIES.editor, ["scene", "editor"]));
  assert.equal(editor.tools.length, 20, "16 scene none + 4 editor bridge");
});

test("legacy VINO_GODOT_MCP_GROUPS alone keeps the pre-P1-C tool set", () => {
  // 旧版本 = 只按领域过滤、不做 dependency 过滤。修复后必须逐领域完全一致。
  const legacyCounts: Array<[string, number]> = [
    ["project,shader", 11], ["project", 9], ["scene", 17], ["runtime", 12], ["class", 3],
    ["editor", 4], ["resource", 4], ["script", 7], ["shader", 2], ["asset", 2], ["utility", 2],
  ];
  for (const [raw, count] of legacyCounts) {
    const sel = selection({ [GROUPS_ENV]: raw });
    assert.equal(sel.tools.length, count, `GROUPS=${raw} must keep ${count} tools`);
    assert.equal(sel.presetSource, "legacy-groups", `GROUPS=${raw} must be recognised as a legacy config`);
    assert.equal(sel.tools.length, allTools.filter((tool) => raw.split(",").includes(tool.domain)).length, `GROUPS=${raw} must not filter by dependency`);
  }
  // 空值/空白仍表示"不过滤领域";此时等价于两个变量都没配置 → default
  for (const raw of [undefined, "", "  ", " , "]) {
    const sel = selection({ [GROUPS_ENV]: raw });
    assert.equal(sel.tools.length, 40);
    assert.equal(sel.presetSource, "default");
  }
  // 显式 full + 空 groups 仍等于全部
  for (const raw of [undefined, "", "  ", " , "]) {
    assert.equal(selection({ [PRESET_ENV]: "full", [GROUPS_ENV]: raw }).tools.length, 62);
  }
});

test("unknown group is rejected with the valid list instead of silently exposing nothing", () => {
  const known = new Set<ToolDomain>(allTools.map((tool) => tool.domain));
  const error = catchError(() => parseToolGroups("scene,nope", known));
  assert.equal(error.code, "INVALID_CONFIGURATION");
  assert.deepEqual((error.details as { unknown: string[] }).unknown, ["nope"]);
  assert.ok((error.details as { validGroups: string[] }).validGroups.includes("scene"));
  // 领域拼错时不能"静默成功并返回空集合"。
  assert.equal(catchError(() => selection({ [PRESET_ENV]: "full", [GROUPS_ENV]: "animation" })).code, "INVALID_CONFIGURATION");
});

test("an empty intersection fails with TOOL_SELECTION_EMPTY plus an actionable fix", () => {
  // class 域全是 godot;editor 预设只有 none + bridge → 交集为空。
  const error = catchError(() => selection({ [PRESET_ENV]: "editor", [GROUPS_ENV]: "class" }));
  assert.equal(error.code, "TOOL_SELECTION_EMPTY");
  assert.deepEqual((error.details as { groups: string[] }).groups, ["class"]);
  assert.equal((error.details as { preset: string }).preset, "editor");
  // 错误必须能直接指导用户改正:建议的预设必须真的能救活这组 groups。
  assert.deepEqual((error.details as { suggestedPresets: string[] }).suggestedPresets, ["runtime", "full"]);
  assert.match(error.message, /Fix: set VINO_GODOT_MCP_PRESET=runtime\|full/);
  for (const preset of (error.details as { suggestedPresets: string[] }).suggestedPresets) {
    assert.ok(selection({ [PRESET_ENV]: preset, [GROUPS_ENV]: "class" }).tools.length > 0, `suggested preset ${preset} must work`);
  }
  // GROUPS-only 的旧配置已经不会再触发空集合(runtime/class/editor 都能起来)
  for (const raw of ["runtime", "class", "editor"]) {
    assert.ok(selection({ [GROUPS_ENV]: raw }).tools.length > 0, `legacy GROUPS=${raw} must not fail`);
  }
});

test("tools with a missing or illegal dependency are rejected before filtering", () => {
  // 正常输入不走异常路径
  assert.equal(selection({ [PRESET_ENV]: "full" }).tools.length, 62);

  const illegal = { ...allTools[0]!, name: "utility_broken", dependency: "network" as unknown as ToolDependency };
  const badError = catchError(() => resolveToolSelection([...allTools, illegal], { [PRESET_ENV]: "full" }));
  assert.equal(badError.code, "INVALID_CONFIGURATION");
  assert.equal((badError.details as { tool: string }).tool, "utility_broken");

  const missing = { ...allTools[0]!, name: "utility_missing", dependency: undefined as unknown as ToolDependency };
  const missingError = catchError(() => resolveToolSelection([missing], {}));
  assert.equal(missingError.code, "INVALID_CONFIGURATION");
  assert.equal((missingError.details as { tool: string }).tool, "utility_missing");
});

// ---------------------------------------------------------------- 不改写工具定义

test("filtering never rewrites name, handler or schema (same objects out)", () => {
  const full = selection({ [PRESET_ENV]: "full" }).tools;
  assert.deepEqual(namesOf(full), namesOf(allTools));
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  for (const tool of full) {
    const original = byName.get(tool.name)!;
    // 同一个对象引用:筛选层只挑选,不重建、不改写
    assert.equal(tool, original, `${tool.name} must be the original definition object`);
    assert.equal(tool.handler, original.handler);
    assert.equal(tool.inputSchema, original.inputSchema);
    assert.equal(tool.dependency, original.dependency);
    assert.equal(tool.runtimeRequired, original.runtimeRequired);
  }
});

// ---------------------------------------------------------------- 注册层

test("composition root registers exactly the selected tools and hides the rest", async () => {
  const host = buildHost(quiet, { [PRESET_ENV]: "default" });
  assert.equal(host.listTools().length, 40);
  assert.deepEqual(host.listTools().map((tool) => tool.name).sort(), expectedFor(["none"]));

  // 已注册的工具照常可用(handler/schema 未变)
  const ping = await host.callTool("utility_ping", { echo: "preset" });
  assert.ok(ping.ok);
  assert.equal((ping.data as { echo: string }).echo, "preset");

  // 被预设排除的工具对 ToolHost 而言就是"不存在"
  const hidden = await host.callTool("project_validate", {});
  assert.equal(hidden.ok, false);
  assert.equal((hidden as { error: { code: string } }).error.code, "TOOL_NOT_FOUND");

  // 组过滤与预设叠加:editor 预设(class 域全是 godot)+ utility,class 组 → 只剩 utility
  const grouped = buildHost(quiet, { [PRESET_ENV]: "editor", [GROUPS_ENV]: "utility,class" });
  assert.deepEqual(grouped.listTools().map((tool) => tool.name).sort(), ["utility_ping", "utility_task_status"]);
});

// ---------------------------------------------------------------- 真实 MCP server

async function connectWith(env: Record<string, string>): Promise<{ client: Client; logs: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: path.resolve(HERE, ".."),
    stderr: "pipe",
    env: { ...getDefaultEnvironment(), VINO_GODOT_MCP_LOG: "debug", ...env },
  });
  const stderr = transport.stderr;
  assert.ok(stderr, "stderr pipe should be available");
  let logs = "";
  stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  const client = new Client({ name: "vino-tool-selection-e2e", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return { client, logs: () => logs };
}

test("real MCP server advertises only the selected tools (preset ∩ group)", async (t) => {
  const { client, logs } = await connectWith({ [PRESET_ENV]: "runtime", [GROUPS_ENV]: "scene,script,utility" });
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedFor(TOOL_PRESET_DEPENDENCIES.runtime, ["scene", "script", "utility"]));
  assert.equal(tools.length, 26, "16 scene none + scene_get_node_info + 7 script + 2 utility");

  // 被排除的工具在协议层就是未知工具(SDK 直接 -32602,不会到 ToolHost)
  await assert.rejects(
    () => client.callTool({ name: "project_validate", arguments: {} }),
    (error: unknown) => /not found/i.test(String((error as Error).message)),
  );

  // 已选中的工具可用
  const ok = await client.callTool({ name: "utility_ping", arguments: { echo: "e2e" } });
  assert.equal(ok.isError, undefined);
  const text = (ok.content as Array<{ type: string; text?: string }>).find((block) => block.type === "text");
  assert.equal((JSON.parse(text!.text!) as { data: { echo: string } }).data.echo, "e2e");

  // 诊断只走 stderr,且包含本次选择结果
  for (let waited = 0; waited < 2000 && !logs().includes("tool selection:"); waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(logs(), /tool selection: preset=runtime source=env dependencies=none\+godot groups=scene,script,utility tools=26\/62/);
});

test("real MCP server without configuration exposes the default preset only", async (t) => {
  const { client } = await connectWith({});
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools.length, 40);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedFor(["none"]));
});

test("real MCP server with a legacy GROUPS-only config exposes the pre-P1-C set", async (t) => {
  // 旧配置:只有 GROUPS,没有 PRESET。不能因为新的默认预设而少暴露或直接起不来。
  const { client, logs } = await connectWith({ [GROUPS_ENV]: "project,shader" });
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.equal(tools.length, 11, "9 project tools + 2 shader tools");
  assert.deepEqual(tools.map((tool) => tool.name).sort(), namesOf(allTools.filter((tool) => ["project", "shader"].includes(tool.domain))));

  // 引擎/桥工具在旧配置下必须依然可用(registry 里存在,只是能不能跑取决于环境)
  const names = tools.map((tool) => tool.name);
  for (const name of ["project_validate", "project_capabilities", "project_get_config"]) {
    assert.ok(names.includes(name), `${name} must stay exposed for a GROUPS-only config`);
  }

  for (let waited = 0; waited < 2000 && !logs().includes("tool selection:"); waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(logs(), /tool selection: preset=full source=legacy-groups dependencies=none\+godot\+bridge groups=project,shader tools=11\/62/);
});

// T29 实机验证：真实 MCP Client → 真实 MCP Server → 真实 Godot Editor（EditorPlugin + UndoRedo）。
//
// 与 editorBridge.real.test.ts 的区别：那组只读、跑在"已经在跑的编辑器"上；这组会**自己启动**
// 一个独立编辑器，且全部写入都发生在 godot_test 的临时副本里 —— 仓库内的夹具不会被改动。
//
// 前置：
//   GODOT_BIN=<真实 Godot 可执行文件>   允许运行并启动编辑器副本
//   T29_EDITOR_GUI=1                   不用 --headless（默认 headless，避免弹窗）
//
// 验证点：UndoRedo 写入 / 原生撤销重做 / 节点增删 / 选择回灌 / 事件流 / 日志回灌 /
//         "编辑器内存改了但磁盘 .tscn 没改"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SOURCE_PROJECT = path.resolve(HERE, "..", "..", "godot_test");
const SERVER_ENTRY = path.resolve(HERE, "../src/index.js");
const GODOT_BIN = process.env["GODOT_BIN"];
const GUI = process.env["T29_EDITOR_GUI"] === "1";
const SCENE = "res://scenes/mcp_test.tscn";
const skip = GODOT_BIN ? false : "GODOT_BIN 未设置（需要真实 Godot 可执行文件）";

interface TextBlock { type: string; text?: string }
type Payload = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } };

function textOf(result: unknown): string {
  const content = (result as { content?: TextBlock[] }).content ?? [];
  const block = content.find((c) => c.type === "text");
  assert.ok(block?.text !== undefined, `expected a text content block, got ${JSON.stringify(result)}`);
  return block.text;
}

function dataOf(p: Payload): Record<string, unknown> {
  assert.equal(p.ok, true, `tool failed: ${JSON.stringify(p.error)}`);
  return p.data as Record<string, unknown>;
}

function codeOf(p: Payload): string {
  assert.equal(p.ok, false, `expected failure, got: ${JSON.stringify(p.data ?? p.error).slice(0, 300)}`);
  return String(p.error?.code);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** godot_test 的副本：不带 .godot/.vino-godot-mcp，让编辑器自己导入，避免旧缓存干扰。 */
function copyProject(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-t29-editor-"));
  fs.cpSync(SOURCE_PROJECT, target, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(SOURCE_PROJECT, src).replace(/\\/g, "/");
      return !(rel === ".godot" || rel.startsWith(".godot/") || rel === ".vino-godot-mcp" || rel.startsWith(".vino-godot-mcp/"));
    },
  });
  return target;
}

async function launchEditor(project: string): Promise<ChildProcess> {
  const args = ["--path", project, "--editor", SCENE];
  if (!GUI) args.unshift("--headless");
  const child = spawn(GODOT_BIN as string, args, { stdio: "ignore", windowsHide: true });
  return child;
}

async function killEditor(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  child.kill();
  for (let waited = 0; waited < 10_000 && child.exitCode === null; waited += 200) await sleep(200);
  if (child.exitCode === null && process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    for (let waited = 0; waited < 10_000 && child.exitCode === null; waited += 200) await sleep(200);
  }
}

async function connect(): Promise<{ client: Client; call: (name: string, args?: Record<string, unknown>) => Promise<Payload> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: REPO_ROOT,
    stderr: "pipe",
    env: { ...getDefaultEnvironment(), VINO_GODOT_MCP_LOG: "warn", VINO_GODOT_MCP_PRESET: "full" },
  });
  const client = new Client({ name: "vino-godot-mcp-t29-wrap", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return { client, call: async (name, args = {}) => JSON.parse(textOf(await client.callTool({ name, arguments: { ...args } }))) as Payload };
}

test("T29 real editor: UndoRedo writes, native undo/redo, selection and log events, disk untouched", { skip, timeout: 600_000 }, async (t) => {
  const project = copyProject();
  const sceneFile = path.join(project, "scenes", "mcp_test.tscn");
  const diskBefore = fs.readFileSync(sceneFile, "utf8");
  const editor = await launchEditor(project);
  const { client, call } = await connect();
  t.after(async () => {
    await client.close();
    await killEditor(editor);
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  const callWithProject = (name: string, args: Record<string, unknown> = {}) => call(name, { projectPath: project, ...args });

  // --- 0) 等编辑器把场景真正打开（插件先起来，场景后打开） ---
  let ready = false;
  for (let waited = 0; waited < 240_000 && !ready; waited += 1_000) {
    try {
      const p = await callWithProject("editor_get_scene");
      ready = p.ok && p.data?.["scenePath"] === SCENE && p.data?.["isValid"] === true;
    } catch { /* 编辑器还在启动 */ }
    if (!ready) await sleep(1_000);
  }
  assert.equal(ready, true, "编辑器副本没有在 240s 内打开 mcp_test.tscn");

  // --- 1) 能力声明必须与实现一致 ---
  const cap = dataOf(await callWithProject("project_capabilities"));
  const native = cap["nativeCapabilities"] as Record<string, unknown>;
  assert.equal(native["editor_scene_write"], true);
  assert.equal(native["editor_undo_redo"], true);
  assert.equal(native["editor_event_stream"], true);
  assert.equal(native["editor_scene_save"], false, "桥不保存场景，必须显式声明");
  assert.ok((cap["bridgeMethods"] as string[]).includes("editor_set_node_property"));
  assert.ok((cap["bridgeMethods"] as string[]).includes("editor_undo"));
  assert.ok((cap["eventTypes"] as string[]).includes("log"));
  assert.equal((cap["logCapture"] as Record<string, unknown>)["installed"], true, "OS.add_logger 必须真的订阅上");
  assert.equal((cap["history"] as Record<string, unknown>)["available"], true);

  // --- 2) 事件环形缓冲在客户端连接之前就已经在记录 ---
  const early = dataOf(await callWithProject("editor_get_events", { sinceSeq: 0, limit: 200 }));
  const earlyEvents = early["events"] as Array<Record<string, unknown>>;
  assert.ok(earlyEvents.length > 0, "编辑器启动期间就应该已经产生事件");
  assert.equal(earlyEvents[0]!["seq"], 1, "seq 从 1 开始单调递增");
  assert.ok((early["sources"] as Record<string, number>)["editorBuffer"]! > 0, "环形缓冲必须能补齐连接前的事件");
  const types = new Set(earlyEvents.map((event) => event["type"]));
  assert.ok(types.has("scene_tree_changed") || types.has("scene_changed"), `expected scene events, got ${[...types].join(",")}`);

  // --- 3) 属性写入 + 磁盘不变 ---
  const set = dataOf(await callWithProject("editor_set_property", {
    nodePath: "World/Player", property: "position", value: { x: 432, y: 111 },
  }));
  assert.equal(set["changed"], true);
  assert.equal(set["undoable"], true);
  assert.deepEqual((set["before"] as Record<string, unknown>)["value"], { x: 320, y: 180 });
  assert.deepEqual((set["after"] as Record<string, unknown>)["value"], { x: 432, y: 111 });
  assert.match(String(set["actionName"]), /MCP: set position on Player/);
  const historyAfterSet = set["history"] as Record<string, unknown>;
  assert.equal(historyAfterSet["canUndo"], true, "写入必须进入可撤销历史");
  assert.match(String(historyAfterSet["currentAction"]), /MCP: set position/);

  const live = dataOf(await callWithProject("editor_get_node", { nodePath: "World/Player", propertyNames: ["position"] }));
  assert.deepEqual(((live["properties"] as Array<Record<string, unknown>>)[0]!)["value"], { x: 432, y: 111 }, "编辑器内存里必须是新值");
  assert.equal(fs.readFileSync(sceneFile, "utf8"), diskBefore, "桥不允许改磁盘 .tscn");

  // 同值再写一次：不应该再产生一个 undo 步骤
  const noop = dataOf(await callWithProject("editor_set_property", { nodePath: "World/Player", property: "position", value: { x: 432, y: 111 } }));
  assert.equal(noop["changed"], false);
  assert.equal(noop["undoable"], false);

  // --- 4) 原生撤销 / 重做（同一条 UndoRedo 历史） ---
  const undo = dataOf(await callWithProject("editor_undo", { steps: 1 }));
  assert.equal(undo["performed"], 1);
  assert.deepEqual(((undo["historyBefore"] as Record<string, unknown>)["canUndo"]), true);
  const afterUndo = dataOf(await callWithProject("editor_get_node", { nodePath: "World/Player", propertyNames: ["position"] }));
  assert.deepEqual(((afterUndo["properties"] as Array<Record<string, unknown>>)[0]!)["value"], { x: 320, y: 180 }, "undo 必须回到原值");

  const redo = dataOf(await callWithProject("editor_redo", { steps: 1 }));
  assert.equal(redo["performed"], 1);
  const afterRedo = dataOf(await callWithProject("editor_get_node", { nodePath: "World/Player", propertyNames: ["position"] }));
  assert.deepEqual(((afterRedo["properties"] as Array<Record<string, unknown>>)[0]!)["value"], { x: 432, y: 111 }, "redo 必须回到新值");

  // 撤销到尽头后再撤销：必须是结构化错误，而不是静默成功
  const drained = await callWithProject("editor_undo", { steps: 20 });
  assert.equal(drained.ok, true);
  const empty = await callWithProject("editor_undo", { steps: 1 });
  assert.equal(codeOf(empty), "EDITOR_HISTORY_EMPTY");

  // --- 5) 新增节点：owner 必须是场景根（否则编辑器不会保存它） ---
  const added = dataOf(await callWithProject("editor_add_node", {
    parentPath: "World", type: "Sprite2D", name: "T29Added", properties: { position: { x: 5, y: 6 } },
  }));
  assert.equal(added["nodePath"], "World/T29Added");
  assert.equal(added["type"], "Sprite2D");
  assert.equal(added["ownerPath"], ".", "新增节点的 owner 必须是编辑场景根");
  assert.equal(added["renamedByEngine"], false);
  const treeAfterAdd = dataOf(await callWithProject("editor_get_tree", { nodePath: "World" }));
  const addedEntry = (treeAfterAdd["nodes"] as Array<Record<string, unknown>>).find((node) => node["path"] === "World/T29Added");
  assert.ok(addedEntry, "editor_get_tree 必须能看到新增节点");
  assert.equal(addedEntry!["type"], "Sprite2D");

  // 重复名字：结构化拒绝，且不留下半成品
  const duplicate = await callWithProject("editor_add_node", { parentPath: "World", type: "Node2D", name: "T29Added" });
  assert.equal(codeOf(duplicate), "EDITOR_NODE_EXISTS");
  // 未知属性：整次新增回滚
  const badProp = await callWithProject("editor_add_node", { parentPath: "World", type: "Node2D", name: "T29BadProp", properties: { nope: 1 } });
  assert.equal(codeOf(badProp), "EDITOR_PROPERTY_INVALID");
  const treeNoBad = dataOf(await callWithProject("editor_get_tree", { nodePath: "World" }));
  assert.equal((treeNoBad["nodes"] as Array<Record<string, unknown>>).some((node) => node["path"] === "World/T29BadProp"), false);
  // 未知类
  assert.equal(codeOf(await callWithProject("editor_add_node", { parentPath: "World", type: "NoSuchClassT29", name: "X" })), "EDITOR_NODE_TYPE_UNKNOWN");

  // undo 撤掉新增节点，redo 再加回来
  dataOf(await callWithProject("editor_undo", { steps: 1 }));
  assert.equal(codeOf(await callWithProject("editor_get_node", { nodePath: "World/T29Added" })), "EDITOR_NODE_NOT_FOUND", "undo 必须移除新增节点");
  dataOf(await callWithProject("editor_redo", { steps: 1 }));
  assert.equal(dataOf(await callWithProject("editor_get_node", { nodePath: "World/T29Added" }))["path"], "World/T29Added");

  // --- 6) 删除节点 + undo 复原（同级顺序与 owner 都要回来） ---
  const removed = dataOf(await callWithProject("editor_remove_node", { nodePath: "World/Environment" }));
  assert.equal(removed["removed"], true);
  assert.equal(removed["ownerPath"], ".");
  assert.equal(codeOf(await callWithProject("editor_get_node", { nodePath: "World/Environment" })), "EDITOR_NODE_NOT_FOUND");
  dataOf(await callWithProject("editor_undo", { steps: 1 }));
  const restored = dataOf(await callWithProject("editor_get_node", { nodePath: "World/Environment" }));
  assert.equal(restored["ownerPath"], ".", "undo 复原后 owner 必须仍然指向场景根");
  assert.equal(codeOf(await callWithProject("editor_remove_node", { nodePath: "." })), "EDITOR_CANNOT_REMOVE_ROOT");

  // --- 7) 选择回灌：焦点 + Inspector 属性 ---
  const selected = dataOf(await callWithProject("editor_select_node", { nodePaths: ["World/Player"] }));
  assert.equal(selected["count"], 1);
  assert.equal(selected["undoable"], false);
  assert.equal(((selected["selection"] as Record<string, unknown>)["count"]), 1);

  let selectionEvent: Record<string, unknown> | undefined;
  for (let waited = 0; waited < 15_000 && !selectionEvent; waited += 500) {
    const page = dataOf(await callWithProject("editor_get_events", { sinceSeq: 0, limit: 200, types: ["selection_changed"] }));
    for (const event of page["events"] as Array<Record<string, unknown>>) {
      const focus = (event["data"] as Record<string, unknown>)["focus"] as Record<string, unknown> | undefined;
      if (focus && focus["path"] === "World/Player") selectionEvent = event;
    }
    if (!selectionEvent) await sleep(500);
  }
  assert.ok(selectionEvent, "selection_changed 事件必须带上聚焦节点");
  const focus = (selectionEvent!["data"] as Record<string, unknown>)["focus"] as Record<string, unknown>;
  assert.equal(focus["type"], "CharacterBody2D");
  assert.ok((focus["properties"] as unknown[]).length > 0, "focus 必须带 Inspector 属性值");
  assert.match(String(focus["source"]), /EditorSelection/);

  // editor_scene_info 的 focus 与事件同构
  const sceneInfo = dataOf(await callWithProject("editor_get_scene"));
  assert.equal((sceneInfo["focus"] as Record<string, unknown>)["path"], "World/Player");

  // --- 8) 推送通道：连接活着时事件是插件主动发的，不是这次请求的应答 ---
  const pushed = (sceneInfo["eventState"] as Record<string, unknown>);
  assert.ok(Number(pushed["nextSeq"]) >= 1);
  const page = dataOf(await callWithProject("editor_get_events", { sinceSeq: 0, limit: 200 }));
  const pushedInfo = page["pushed"] as Record<string, number>;
  assert.ok(pushedInfo["received"]! >= 1, `插件必须主动推送过事件（received=${pushedInfo["received"]}）`);
  assert.ok((page["sources"] as Record<string, number>)["merged"]! > 0);

  // --- 9) 日志回灌：往副本里丢一个语法错误的脚本，编辑器必须把它当 Error 报出来 ---
  fs.writeFileSync(path.join(project, "t29_log_probe.gd"), "func broken(:\n\tpass\n", "utf8");
  let logEvent: Record<string, unknown> | undefined;
  let seenLogs: Array<Record<string, unknown>> = [];
  const since = Number(page["nextSeq"] ?? 0);
  for (let waited = 0; waited < 30_000 && !logEvent; waited += 1_000) {
    const logsPage = dataOf(await callWithProject("editor_get_events", { sinceSeq: since, limit: 200, types: ["log"] }));
    for (const event of logsPage["events"] as Array<Record<string, unknown>>) {
      const data = event["data"] as Record<string, unknown>;
      seenLogs.push(data);
      if (String(data["level"]) === "error" || String(data["message"]).includes("Parse Error")) logEvent = event;
    }
    if (!logEvent) await sleep(1_000);
  }
  assert.ok(logEvent, `OS.add_logger 必须把编辑器错误回灌成 log 事件；实际收到 ${JSON.stringify(seenLogs).slice(0, 400)}`);
  assert.equal(((logEvent!["data"] as Record<string, unknown>)["source"]), "godot_editor_process");

  // --- 10) 结束状态：磁盘仍然与开始时逐字节一致 ---
  assert.equal(fs.readFileSync(sceneFile, "utf8"), diskBefore, "整场验证不允许写磁盘场景");
  const finalScene = dataOf(await callWithProject("editor_get_scene"));
  assert.equal(finalScene["scenePath"], SCENE);
});

// T13-C1:用**真实 MCP Client**(官方 @modelcontextprotocol/client,stdio)驱动**真实 MCP Server**,
// 访问**真实 Godot Editor**(插件 + TCP Bridge + EditorInterface),项目固定为 godot_test。
//
//   真实链路:MCP Client -> MCP Server -> Native Bridge -> EditorPlugin -> EditorInterface -> 当前编辑场景
//
// 前置(测试自身不启动/关闭 Editor,避免误杀用户进程):
//   GODOT_EDITOR_BRIDGE=1    允许运行(否则整组 skip)
//   EXPECT_EDITOR_PID=<pid>  godot_test 那个 Editor 的 PID(核对 descriptor 与插件自报)
//   MCP_EXPECT_UNSAVED=1     额外断言:Editor 里有**未保存**修改,磁盘 .tscn 仍是旧值
//
// 只读:所有调用都是 read-only 工具,不写场景、不保存。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(HERE, "../src/index.js");
const PROJECT = path.resolve(HERE, "..", "..", "godot_test");
const SCENE = "res://scenes/mcp_test.tscn";

const ENABLED = process.env["GODOT_EDITOR_BRIDGE"] === "1";
const EXPECT_PID = process.env["EXPECT_EDITOR_PID"] ? Number(process.env["EXPECT_EDITOR_PID"]) : undefined;
const EXPECT_UNSAVED = process.env["MCP_EXPECT_UNSAVED"] === "1";
const skip = ENABLED ? false : "GODOT_EDITOR_BRIDGE 未设置(需要真实的 godot_test Editor)";

interface TextBlock { type: string; text?: string }
type Payload = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } };

function textOf(result: unknown): string {
  const content = (result as { content?: TextBlock[] }).content ?? [];
  const block = content.find((c) => c.type === "text");
  assert.ok(block?.text !== undefined, `expected a text content block, got ${JSON.stringify(result)}`);
  return block.text;
}

/** 真实 MCP server 子进程 + 真实 client;每个 test 独立一台 server。 */
async function connect(): Promise<{ client: Client; call: (name: string, args?: Record<string, unknown>) => Promise<Payload> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: path.resolve(SERVER_ENTRY, "../.."),
    stderr: "pipe",
    env: { ...getDefaultEnvironment(), VINO_GODOT_MCP_LOG: "warn" },
  });
  const client = new Client({ name: "vino-godot-mcp-editor-e2e", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return {
    client,
    call: async (name, args = {}) => JSON.parse(textOf(await client.callTool({ name, arguments: { projectPath: PROJECT, ...args } }))) as Payload,
  };
}

function dataOf(p: Payload): Record<string, unknown> {
  assert.equal(p.ok, true, `tool failed: ${JSON.stringify(p.error)}`);
  return p.data as Record<string, unknown>;
}

function codeOf(p: Payload): string {
  assert.equal(p.ok, false, `expected failure, got: ${JSON.stringify(p.data ?? p.error).slice(0, 400)}`);
  assert.equal(typeof p.error?.code, "string");
  return p.error!.code;
}

const normalize = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();

/** 造一个"存在但不是 godot_test"的项目根(ProjectResolver 要求 project.godot 存在)。 */
function makeTempProject(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="Other Project"\n', "utf8");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 锚点/偏移在引擎里是 float32,0.1 会变成 0.10000000149,比较必须带容差。 */
function near(actual: unknown, expected: number, eps = 1e-6): void {
  assert.equal(typeof actual, "number", `expected a number, got ${JSON.stringify(actual)}`);
  assert.ok(Math.abs((actual as number) - expected) < eps, `${actual} != ${expected} (±${eps})`);
}

test("E2 editor bridge: identity, game-not-running, scene/tree/node/layout match the live editor", { skip, timeout: 180_000 }, async (t) => {
  const { client, call } = await connect();
  t.after(() => client.close());

  // --- 0) 工具已上线 ---
  const { tools } = await client.listTools();
  for (const name of ["editor_get_scene", "editor_get_tree", "editor_get_node", "editor_get_layout", "project_capabilities"]) {
    assert.ok(tools.some((x) => x.name === name), `${name} must be advertised`);
  }

  // --- 1) 身份与能力(descriptor + 插件自报) ---
  const cap = dataOf(await call("project_capabilities"));
  assert.equal(cap["context"], "editor");
  assert.equal(cap["editorConnected"], true);
  assert.equal(cap["pluginRunning"], true);
  assert.equal(cap["isPlayingScene"], false, "游戏必须处于未运行状态");
  assert.equal(normalize(String(cap["projectPath"])), normalize(PROJECT));
  const bridge = cap["bridge"] as { port: number; pid: number | null; sessionId: string };
  assert.ok(bridge.port > 0, "bridge port 必须真实存在");
  assert.equal(bridge.pid, cap["editorPid"], "descriptor 的 pid 必须等于插件自报的 pid");
  if (EXPECT_PID !== undefined) assert.equal(cap["editorPid"], EXPECT_PID, "必须是我们启动的那个 Editor PID");
  assert.equal((cap["currentScene"] as Record<string, unknown>)["path"], SCENE);
  assert.equal((cap["currentScene"] as Record<string, unknown>)["isDirty"], null, "Godot 4.6 无脏标记查询,必须报 null 而不是猜");

  // --- 2) 当前编辑场景 ---
  const scene = dataOf(await call("editor_get_scene"));
  assert.equal(scene["isValid"], true);
  assert.equal(scene["hasEditedScene"], true);
  assert.equal(scene["scenePath"], SCENE);
  assert.equal(scene["rootName"], "MCPTestRoot");
  assert.equal(scene["rootClass"], "Node2D");
  assert.equal(scene["neverSaved"], false);
  assert.equal(scene["isPlayingScene"], false);
  assert.equal(typeof scene["objectId"], "string", "objectId 必须是十进制字符串(int64 不能塞进 JSON number)");
  const openScenes = scene["openScenes"] as Array<Record<string, unknown>>;
  const current = openScenes.filter((s) => s["isCurrent"] === true);
  assert.equal(current.length, 1, "恰好一个 isCurrent 场景");
  assert.equal(current[0]!["path"], SCENE);
  assert.equal(current[0]!["objectId"], scene["objectId"]);

  // --- 3) 完整节点树(与场景结构逐项对齐) ---
  const tree = dataOf(await call("editor_get_tree", { maxDepth: 32, maxNodes: 1000 }));
  const nodes = tree["nodes"] as Array<Record<string, unknown>>;
  assert.deepEqual(nodes.map((n) => `${n["path"]}|${n["type"]}`), [
    ".|Node2D",
    "World|Node2D",
    "World/Player|CharacterBody2D",
    "World/Player/Sprite|Sprite2D",
    "World/Player/CollisionShape2D|CollisionShape2D",
    "World/Environment|Node2D",
    "UI|CanvasLayer",
    "UI/ControlRoot|Control",
    "UI/ControlRoot/Background|ColorRect",
    "UI/ControlRoot/Panel|PanelContainer",
    "UI/ControlRoot/Panel/VBoxContainer|VBoxContainer",
    "UI/ControlRoot/Panel/VBoxContainer/Title|Label",
    "UI/ControlRoot/Panel/VBoxContainer/StartButton|Button",
    "UI/ControlRoot/Panel/VBoxContainer/ExitButton|Button",
  ]);
  assert.equal(tree["truncated"], false);
  assert.equal(tree["nodeCount"], 14);
  assert.equal(tree["context"], "editor");

  const byPath = new Map(nodes.map((n) => [n["path"] as string, n]));
  const player = byPath.get("World/Player")!;
  assert.equal(player["className"], "MCPTestPlayer", "脚本 class_name 必须来自真实脚本");
  assert.equal(player["scriptPath"], "res://scenes/mcp_test_player.gd");
  assert.equal(player["parentPath"], "World");
  assert.equal(player["ownerPath"], ".");
  assert.ok((player["groups"] as string[]).includes("player"), "分组必须来自真实编辑器实例");
  assert.ok((player["groups"] as string[]).includes("mcp_test_movable"));
  assert.equal(byPath.get("UI/ControlRoot/Panel/VBoxContainer/Title")!["uniqueNameInOwner"], true);
  assert.equal(player["depth"], 2);
  assert.equal(byPath.get("World/Player/Sprite")!["depth"], 3);
  assert.match(String(player["instanceId"]), /^\d+$/);

  // 深度限制必须真的生效
  const shallow = dataOf(await call("editor_get_tree", { maxDepth: 1 }));
  assert.deepEqual((shallow["nodes"] as Array<Record<string, unknown>>).map((n) => n["path"]), [".", "World", "UI"]);
  assert.equal(shallow["truncated"], true);
  assert.equal((shallow["truncatedBy"] as Record<string, unknown>)["maxDepth"], true);

  // 指定子树 + 数量上限
  const uiTree = dataOf(await call("editor_get_tree", { nodePath: "UI/ControlRoot", maxNodes: 3 }));
  assert.equal(uiTree["rootPath"], "UI/ControlRoot");
  assert.equal((uiTree["nodes"] as unknown[]).length, 3);
  assert.equal(uiTree["truncated"], true);
  assert.equal((uiTree["truncatedBy"] as Record<string, unknown>)["maxNodes"], true);
  // ControlRoot + Background + Panel + VBox + Title + StartButton + ExitButton = 7(被 maxNodes 截断也要报全量)
  assert.equal(uiTree["subtreeNodeCount"], 7, "subtreeNodeCount 必须是整棵子树计数");

  // --- 4) 节点属性 ---
  const playerInfo = dataOf(await call("editor_get_node", { nodePath: "World/Player" }));
  assert.equal(playerInfo["path"], "World/Player");
  assert.equal(playerInfo["type"], "CharacterBody2D");
  assert.equal(playerInfo["isControl"], false);
  assert.ok((playerInfo["groups"] as string[]).includes("player"));
  assert.ok(String(playerInfo["nodePathAbsolute"]).endsWith("MCPTestRoot/World/Player"), "绝对路径证明这是编辑器里实例化的节点");
  const props = new Map((playerInfo["properties"] as Array<Record<string, unknown>>).map((p) => [p["name"] as string, p]));
  assert.deepEqual(props.get("position")!["value"], { x: EXPECT_UNSAVED ? 410 : 320, y: EXPECT_UNSAVED ? 265 : 180 });
  assert.equal(props.get("move_speed")!["value"], 120);
  assert.equal(props.get("player_label")!["value"], "MCPTestPlayer");
  // Object/Resource 只给引用描述,不深序列化
  const scriptValue = props.get("script")!["value"] as Record<string, unknown>;
  assert.equal(scriptValue["kind"], "Resource");
  assert.equal(scriptValue["resourcePath"], "res://scenes/mcp_test_player.gd");
  // 非 Node 的 ObjectID 最高位被引擎置位,按有符号 int64 打印就是负数(实测),这里只校验它是十进制字符串
  assert.match(String(scriptValue["instanceId"]), /^-?\d+$/);

  // 不存在的节点:必须是 EDITOR_NODE_NOT_FOUND,并带回 editor 身份,而不是统一成"连接关闭"
  const notFound = await call("editor_get_node", { nodePath: "World/NoSuchNode" });
  assert.equal(codeOf(notFound), "EDITOR_NODE_NOT_FOUND");
  assert.equal(notFound.error!.details!["context"], "editor");
  assert.equal(notFound.error!.details!["scenePath"], SCENE);

  // 三种 properties 模式必须真的不同:none 不枚举 / list 只给元数据 / values 读值
  const identityOnly = dataOf(await call("editor_get_node", { nodePath: "World/Player", properties: "none" }));
  assert.deepEqual(identityOnly["properties"], []);
  assert.equal(identityOnly["propertyCount"], 0);
  const listOnly = dataOf(await call("editor_get_node", { nodePath: "World/Player", properties: "list", propertyNames: ["position"] }));
  const listProp = (listOnly["properties"] as Array<Record<string, unknown>>)[0]!;
  assert.equal(listProp["name"], "position");
  assert.equal(listProp["type"], "Vector2");
  assert.equal(listProp["value"], undefined, "list 模式不得读取属性值");

  // --- 5) Control 布局(游戏未运行) ---
  const layout = dataOf(await call("editor_get_layout", { nodePaths: ["UI/ControlRoot", "UI/ControlRoot/Panel", "UI/ControlRoot/Panel/VBoxContainer/StartButton"] }));
  assert.equal(layout["layoutCount"], 3);
  const layouts = layout["layouts"] as Array<Record<string, unknown>>;
  const rootL = layouts[0]!;
  const panelL = layouts[1]!;
  const buttonL = layouts[2]!;

  assert.deepEqual(rootL["anchors"], { left: 0, top: 0, right: 1, bottom: 1 });
  assert.equal(rootL["containerManaged"], false);
  assert.equal(rootL["layoutBasis"], "project_window_size");
  const win = rootL["projectWindowSize"] as Record<string, number>;
  assert.deepEqual(rootL["size"], { x: win["x"], y: win["y"] }, "root Control 必须按项目窗口尺寸布局");

  const panelAnchors = panelL["anchors"] as Record<string, unknown>;
  near(panelAnchors["left"], 0.1); near(panelAnchors["top"], 0.15);
  near(panelAnchors["right"], 0.9); near(panelAnchors["bottom"], 0.85);
  assert.deepEqual(panelL["offsets"], { left: 0, top: 0, right: 0, bottom: 0 });
  assert.equal(panelL["layoutBasis"], "parent_control");
  assert.equal((panelL["parentRect"] as Record<string, number>)["w"], win["x"]);
  const panelSize = panelL["size"] as Record<string, number>;
  assert.ok(Math.abs(panelSize["x"]! - win["x"]! * 0.8) < 0.01, "Panel 宽度必须等于父级宽度 * 0.8");
  assert.ok(Math.abs(panelSize["y"]! - win["y"]! * 0.7) < 0.01);
  assert.deepEqual(panelL["customMinimumSize"], { x: 240, y: 140 });
  assert.deepEqual(panelL["pivotOffset"], { x: 20, y: 10 });
  // 枚举名必须与数值自洽(数值来自 Control 的 ClassDB 枚举),不写死引擎默认值
  const growNames: Record<number, string> = { 0: "GROW_DIRECTION_BEGIN", 1: "GROW_DIRECTION_END", 2: "GROW_DIRECTION_BOTH" };
  const dirNames: Record<number, string> = { 0: "LAYOUT_DIRECTION_INHERITED", 1: "LAYOUT_DIRECTION_APPLICATION_LOCALE", 2: "LAYOUT_DIRECTION_LTR", 3: "LAYOUT_DIRECTION_RTL", 4: "LAYOUT_DIRECTION_SYSTEM_LOCALE" };
  for (const key of ["growHorizontal", "growVertical"]) {
    const g = panelL[key] as Record<string, number | string>;
    assert.equal(g["name"], growNames[g["value"] as number], `${key} 名称与数值必须自洽`);
  }
  const direction = panelL["layoutDirection"] as Record<string, number | string>;
  assert.equal(direction["name"], dirNames[direction["value"] as number]);
  assert.equal(direction["name"], "LAYOUT_DIRECTION_INHERITED", "Panel 未显式设置方向,继承自父级");
  assert.equal(typeof (panelL["globalRect"] as Record<string, unknown>)["w"], "number");

  assert.equal(buttonL["containerManaged"], true, "Container 子节点的位置由容器决定");
  assert.equal((buttonL["parent"] as Record<string, unknown>)["type"], "VBoxContainer");
  assert.equal((buttonL["sizeFlagsHorizontal"] as Record<string, unknown>)["value"], 3);
  assert.deepEqual((buttonL["sizeFlagsHorizontal"] as Record<string, unknown>)["flags"], ["SIZE_FILL", "SIZE_EXPAND"]);
  assert.ok((buttonL["notes"] as string[]).some((n) => n.includes("Container")));

  // 非 Control / 不存在路径:分开报,不伪造布局
  const mixed = dataOf(await call("editor_get_layout", { nodePaths: ["World/Player", "UI/Nope"] }));
  assert.deepEqual(mixed["notControl"], [{ path: "World/Player", type: "CharacterBody2D", reason: "not_control" }]);
  assert.deepEqual(mixed["missing"], [{ path: "UI/Nope", reason: "not_found" }]);
  assert.equal(mixed["layoutCount"], 0);

  // --- 6) descriptor 属于别的项目 -> EDITOR_INSTANCE_MISMATCH ---
  const otherProject = makeTempProject(t, "mcp-editor-other-");
  fs.mkdirSync(path.join(otherProject, ".vino-godot-mcp"), { recursive: true });
  fs.copyFileSync(path.join(PROJECT, ".vino-godot-mcp", "bridge.json"), path.join(otherProject, ".vino-godot-mcp", "bridge.json"));
  const mismatch = await call("editor_get_scene", { projectPath: otherProject });
  assert.equal(codeOf(mismatch), "EDITOR_INSTANCE_MISMATCH");
  assert.equal(normalize(String(mismatch.error!.details!["editorProjectPath"])), normalize(PROJECT));

  // --- 7) 没有 descriptor 的项目 -> BRIDGE_UNAVAILABLE(不是"连接关闭") ---
  const bare = makeTempProject(t, "mcp-editor-bare-");
  const unavailable = await call("editor_get_scene", { projectPath: bare });
  assert.equal(codeOf(unavailable), "BRIDGE_UNAVAILABLE");
});

test("E3 unsaved editor state: MCP returns in-memory values that the .tscn on disk does not contain", { skip: ENABLED && EXPECT_UNSAVED ? false : "需要 MCP_EXPECT_UNSAVED=1 与未保存的编辑器修改", timeout: 180_000 }, async (t) => {
  const { client, call } = await connect();
  t.after(() => client.close());

  // ① 磁盘状态(纯 .tscn 解析)
  const disk = dataOf(await call("scene_get_tree", { path: SCENE }));
  const diskNodes = (disk["tree"] as { nodes: Array<Record<string, unknown>> }).nodes;
  const diskByPath = new Map(diskNodes.map((n) => [n["path"] as string, n]));
  const diskProp = (nodePath: string, name: string): string | undefined => {
    const node = diskByPath.get(nodePath);
    if (!node) return undefined;
    const list = node["properties"] as Array<{ name: string; value: string }>;
    return list?.find((p) => p.name === name)?.value;
  };
  assert.equal(diskProp("World/Player", "position"), "Vector2(320, 180)", "磁盘上仍是保存过的旧值");
  assert.equal(diskProp("UI/ControlRoot/Panel/VBoxContainer/Title", "text"), "\"MCP Test Scene\"");

  // ② Editor 实时状态(未保存)
  const live = dataOf(await call("editor_get_node", { nodePath: "World/Player" }));
  const liveProps = new Map((live["properties"] as Array<Record<string, unknown>>).map((p) => [p["name"] as string, p]));
  assert.deepEqual(liveProps.get("position")!["value"], { x: 410, y: 265 }, "Editor 内存里必须是未保存的新值");
  assert.equal(liveProps.get("position")!["status"], "ok");

  const title = dataOf(await call("editor_get_node", { nodePath: "UI/ControlRoot/Panel/VBoxContainer/Title", propertyNames: ["text"] }));
  const titleProps = title["properties"] as Array<Record<string, unknown>>;
  assert.equal(titleProps.length, 1);
  assert.equal(titleProps[0]!["value"], "Unsaved Title From Editor");

  const buttonLayout = dataOf(await call("editor_get_layout", { nodePath: "UI/ControlRoot/Panel/VBoxContainer/StartButton" }));
  const buttonNode = dataOf(await call("editor_get_node", { nodePath: "UI/ControlRoot/Panel/VBoxContainer/StartButton", propertyNames: ["custom_minimum_size"] }));
  const buttonProps = (buttonNode["properties"] as Array<Record<string, unknown>>);
  assert.deepEqual(buttonProps[0]!["value"], { x: 180, y: 44 }, "Control 布局修改必须来自 Editor 内存");
  assert.equal((buttonLayout["layout"] as Record<string, unknown>)["context"], "editor");
  assert.deepEqual((buttonLayout["layout"] as Record<string, unknown>)["customMinimumSize"], { x: 180, y: 44 });

  // ③ 结论性对比:编辑器值 != 磁盘值,且来源标注为 editor
  assert.equal(live["context"], "editor");
  assert.equal(live["scenePath"], SCENE);
  const treeInfo = dataOf(await call("editor_get_tree", { nodePath: "World/Player", maxDepth: 0 }));
  assert.equal((treeInfo["nodes"] as Array<Record<string, unknown>>)[0]!["context"], "editor");
});

// P3:runtime_inspect_ui 用真实 Godot 验证运行时布局探针(非 headless;headless 视口恒 64x64,布局会被压扁)。
//
// 约定:真实测试只读环境变量 GODOT_BIN,未设置则整组 skip(与 runtime.real.test.ts 同)。
// fixture(tests/fixture_project_ui)先用 mkdtemp 拷到临时目录再跑,仓库副本保持原样;
// 并断言调用前后 main.tscn 的 sha256 不变(探针严格只读:不保存场景、不写项目文件)。
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
import { RuntimeService, type InspectedUiNode } from "../src/services/runtimeService.js";
import { runtimeInspectUi } from "../src/tools/runtime/inspectUi.js";
import type { AppContext } from "../src/services/context.js";
import type { ToolResult } from "../src/types/index.js";

const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project_ui");
const GODOT_BIN = process.env["GODOT_BIN"];
const TIMEOUT_MS = 60_000;
const SCENE = "res://main.tscn";

const quiet = createLogger("error", () => {});
const skip = GODOT_BIN ? false : "GODOT_BIN 未设置";

interface Harness { dir: string; host: ToolHost<AppContext> }

function makeHarness(t: { after: (fn: () => void) => void }): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-ui-real-"));
  t.after(() => {
    if (process.env["P3_KEEP"] === "1") {
      console.log(`P3 temp dir kept: ${dir}`);
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: GODOT_BIN } });
  const runtime = new RuntimeService({ godot, project, runQueue: new TaskQueue(new LockManager()) });
  const ctx = { runtime } as unknown as AppContext;
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll([runtimeInspectUi]), ctx, quiet) };
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: unknown }).data as Record<string, unknown>;
}

interface UiData {
  scene: string;
  viewportSize: { width: number; height: number };
  nodeCount: number;
  truncated: boolean;
  nodes: InspectedUiNode[];
  missing: string[];
  summary: Record<string, number>;
  engineVersion: string;
  durationMs: number;
}

/** 经 ToolHost 跑一次探针,返回 data(超时/错误按现有信封暴露)。 */
async function inspect(host: ToolHost<AppContext>, args: Record<string, unknown>): Promise<UiData> {
  return ok(await host.callTool("runtime_inspect_ui", { scene: SCENE, timeoutMs: TIMEOUT_MS, ...args })) as unknown as UiData;
}

function nodeAt(data: UiData, p: string): InspectedUiNode {
  const n = data.nodes.find((x) => x.path === p);
  assert.ok(n, `节点 ${p} 未返回;实际返回 [${data.nodes.map((x) => x.path).join(", ")}]`);
  return n;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test(
  "real: 全量遍历 —— 真实布局矩形 / out_of_parent / zero_size / summary,且场景文件 hash 不变",
  { skip },
  async (t) => {
    const { dir, host } = makeHarness(t);
    const sceneFile = path.join(dir, "main.tscn");
    const before = sha256(sceneFile);

    const data = await inspect(host, {});

    // 顶层字段
    assert.equal(data.scene, SCENE);
    assert.deepEqual(data.viewportSize, { width: 640, height: 360 }); // 来自 project.godot 的 viewport 设置
    // 同 runtime.checkAddonStatus:补丁位为 0 时版本串只有两段(4.6-stable (official))。
    assert.match(data.engineVersion, /^4\.\d+(\.\d+)?/);
    assert.equal(data.truncated, false);
    assert.deepEqual(data.missing, []);
    assert.ok(data.durationMs > 0);
    // visible=false 的 Box/Hidden 默认不返回 → 7 个 Control
    assert.equal(data.nodeCount, 7);
    assert.deepEqual(data.nodes.map((n) => n.path).sort(), [".", "Box", "Box/Overflow", "Box/Zero", "Ok", "VBox", "VBox/Button"]);

    // 引擎算出来的真实矩形(与 tests/fixtures 中记录的实测一致)
    assert.deepEqual(nodeAt(data, ".").global_rect, [0, 0, 640, 360]);
    assert.deepEqual(nodeAt(data, "Ok").global_rect, [10, 10, 100, 50]);
    assert.deepEqual(nodeAt(data, "Box").global_rect, [20, 80, 200, 100]);
    assert.deepEqual(nodeAt(data, "Box/Overflow").global_rect, [170, 130, 100, 100]);
    assert.deepEqual(nodeAt(data, "Box/Zero").global_rect, [25, 85, 0, 0]);
    assert.deepEqual(nodeAt(data, "VBox").global_rect, [300, 20, 200, 100]);

    // 父级/可见性元数据
    const overflow = nodeAt(data, "Box/Overflow");
    assert.equal(overflow.parent_path, "Box");
    assert.equal(overflow.parent_is_container, false);
    assert.equal(overflow.parent_clip_contents, false);
    assert.deepEqual(overflow.parent_rect, [20, 80, 200, 100]);
    assert.equal(nodeAt(data, ".").parent_rect, null, "场景根的父节点是 root Window,不是 Control");

    // issues:超出父节点但仍在视口内 → 只有 out_of_parent
    assert.deepEqual(overflow.issues, ["out_of_parent"]);
    assert.deepEqual(nodeAt(data, "Box/Zero").issues, ["zero_size"]);
    assert.deepEqual(nodeAt(data, ".").issues, []);
    assert.deepEqual(nodeAt(data, "Box").issues, []);
    assert.deepEqual(nodeAt(data, "Ok").issues, []);

    // 容器布局:Button 被 VBoxContainer 拉满宽度,高度取字体最小高度
    const button = nodeAt(data, "VBox/Button");
    assert.equal(button.class, "Button");
    assert.equal(button.parent_is_container, true, "父节点 VBoxContainer 应被识别为 Container");
    assert.deepEqual(button.global_rect, [300, 20, 200, button.min_size[1]]);
    assert.deepEqual(button.size, [200, button.min_size[1]]);
    assert.ok(button.min_size[0] > 0 && button.min_size[1] > 0, "Button 的最小尺寸应由字体算出");
    assert.deepEqual(button.issues, []);

    // summary 只统计 returned nodes
    assert.deepEqual(data.summary, {
      out_of_parent: 1, out_of_viewport: 0, zero_size: 1, smaller_than_min: 0, clipped_by_parent: 0,
    });

    // 只读:场景文件字节级不变
    assert.equal(sha256(sceneFile), before, "探针不得改动场景文件");
  },
);

test(
  "real: nodePaths 只查指定节点,未知路径进 missing[],显式请求的隐藏节点照样返回",
  { skip },
  async (t) => {
    const { host } = makeHarness(t);
    const data = await inspect(host, { nodePaths: [".", "VBox/Button", "Box/Hidden", "Nope"] });

    assert.equal(data.nodeCount, 3);
    assert.deepEqual(data.nodes.map((n) => n.path).sort(), [".", "Box/Hidden", "VBox/Button"]);
    assert.deepEqual(data.missing, ["Nope"]);
    // 显式点名 Box/Hidden:即使 visible=false 也返回,但 visible_in_tree 为 false
    const hidden = nodeAt(data, "Box/Hidden");
    assert.equal(hidden.visible, false);
    assert.equal(hidden.visible_in_tree, false);
    assert.deepEqual(hidden.issues, []);
  },
);

test(
  "real: includeHidden=true 时全量遍历包含不可见 Control",
  { skip },
  async (t) => {
    const { host } = makeHarness(t);
    const data = await inspect(host, { includeHidden: true });
    assert.equal(data.nodeCount, 8);
    assert.equal(nodeAt(data, "Box/Hidden").visible_in_tree, false);
  },
);

test(
  "real: maxNodes 截断 —— nodes 变短但 nodeCount 仍报总数,truncated=true",
  { skip },
  async (t) => {
    const { host } = makeHarness(t);
    const data = await inspect(host, { maxNodes: 2 });
    assert.equal(data.nodeCount, 7);
    assert.equal(data.nodes.length, 2);
    assert.equal(data.truncated, true);
  },
);

test(
  "real: width/height 覆盖视口并驱动重新布局",
  { skip },
  async (t) => {
    const { host } = makeHarness(t);
    const data = await inspect(host, { width: 500, height: 300 });
    assert.deepEqual(data.viewportSize, { width: 500, height: 300 });
    assert.deepEqual(nodeAt(data, ".").global_rect, [0, 0, 500, 300]);
    // VBox 固定在 (300,20)-(500,120),不随视口变化
    assert.deepEqual(nodeAt(data, "VBox").global_rect, [300, 20, 200, 100]);
  },
);

test(
  "real: 场景不存在 → FILE_NOT_FOUND",
  { skip },
  async (t) => {
    const { host } = makeHarness(t);
    const r = await host.callTool("runtime_inspect_ui", { scene: "res://nope.tscn", timeoutMs: TIMEOUT_MS });
    assert.equal(r.ok, false);
    const err = (r as { ok: false; error: { code: string; details?: Record<string, unknown> } }).error;
    assert.equal(err.code, "FILE_NOT_FOUND");
    assert.equal(err.details?.["scene"], "res://nope.tscn");
  },
);

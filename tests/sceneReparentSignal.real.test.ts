// T027:用真实 Godot 4.6.3 验证两个高危缺陷的修复。
//   D2 —— scene_reparent_node 同步改写 [connection] 的 from/to 路径(否则引擎加载时静默丢连接);
//   D3 —— scene_connect_signal 用 ClassDB 拦截不存在的信号名(否则写进去的无效连接直到加载才炸)。
//
// 约定:真实测试只读环境变量 GODOT_BIN,未设置则整组 skip(与 sceneWriteTools.real.test.ts 同)。
// D3 需要 ClassDB,所以本组测试把 GODOT_PATH 指向同一个引擎(ClassDB 只能由引擎给出)。
// 调试用逃生口:T027_KEEP=1 时不删临时目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { defaultRunRunner } from "../src/godot/runtime/run.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";

const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");
const VERIFY_GD = path.join(import.meta.dirname!, "..", "..", "tests", "fixtures", "t027_verify.gd");
const GODOT_BIN = process.env["GODOT_BIN"];
const TIMEOUT_MS = 60_000;
const SCENE = "res://scenes/main.tscn";

const quiet = createLogger("error", () => {});

interface Host { dir: string; host: ToolHost<AppContext> }

function makeHost(t: { after: (fn: () => void) => void }): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-t027-"));
  t.after(() => {
    if (process.env["T027_KEEP"] === "1") {
      console.log(`T027 temp dir kept: ${dir}`);
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.cpSync(FIXTURE, dir, { recursive: true });
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

test(
  "real: D3 拼错的信号名被 ClassDB 拦截,D2 重挂父节点后连接仍被引擎建立",
  { skip: GODOT_BIN ? false : "GODOT_BIN 未设置" },
  async (t) => {
    // ClassDB dump 与 `--version` 都由 GodotCliService 走 GODOT_PATH;用同一个真实引擎
    const previousPath = process.env["GODOT_PATH"];
    process.env["GODOT_PATH"] = GODOT_BIN!;
    t.after(() => {
      if (previousPath === undefined) delete process.env["GODOT_PATH"];
      else process.env["GODOT_PATH"] = previousPath;
    });

    const { dir, host } = makeHost(t);
    const sceneFile = path.join(dir, "scenes", "main.tscn");

    // ── D3:按钮上拼错的信号必须被拦截,且文件不得被改动 ──────────────────────
    ok(await host.callTool("scene_add_node", { path: SCENE, parentPath: ".", nodeType: "Button", nodeName: "StartButton" }));
    const bad = err(await host.callTool("scene_connect_signal", {
      path: SCENE, sourcePath: "StartButton", signal: "press", targetPath: ".", method: "_on_ready",
    }));
    assert.equal(bad.code, "INVALID_ARGUMENT");
    assert.match(bad.message, /Node type 'Button' has no signal 'press'/);
    assert.match(bad.message, /Did you mean 'pressed'/);
    assert.ok(
      ((bad.details?.["suggestions"] ?? []) as string[]).includes("pressed"),
      `details.suggestions 应包含 pressed: ${JSON.stringify(bad.details)}`,
    );
    assert.ok(!fs.readFileSync(sceneFile, "utf8").includes('signal="press"'), "非法信号不得落盘");

    // 正确信号:ClassDB 确认存在后才写入
    const good = ok(await host.callTool("scene_connect_signal", {
      path: SCENE, sourcePath: "StartButton", signal: "pressed", targetPath: ".", method: "_on_ready",
    }));
    assert.equal(good["status"], "connected");
    assert.equal((good["signalValidation"] as { status: string }).status, "verified");

    // ── D2:带连接的子树重挂父节点,连接路径随子树改写 ────────────────────────
    ok(await host.callTool("scene_add_node", { path: SCENE, parentPath: ".", nodeType: "Node2D", nodeName: "Holder" }));
    ok(await host.callTool("scene_add_node", { path: SCENE, parentPath: "Holder", nodeType: "Marker2D", nodeName: "Leaf" }));
    ok(await host.callTool("scene_connect_signal", {
      path: SCENE, sourcePath: "Holder/Leaf", signal: "tree_exited", targetPath: ".", method: "_on_ready",
    }));
    const moved = ok(await host.callTool("scene_reparent_node", { path: SCENE, nodePath: "Holder", newParentPath: "Player" }));
    assert.equal(moved["connections"], 1, "引用被移动路径的连接必须被同步改写");

    const ourText = fs.readFileSync(sceneFile, "utf8");
    assert.ok(ourText.includes('from="Player/Holder/Leaf"'), "连接 from 必须指向新路径");
    assert.ok(!ourText.includes('from="Holder/Leaf"'), "旧路径必须消失");

    // ── 引擎加载:连接真的被建立(路径不同步时引擎会静默丢弃,这条断言就是 D2 的验收) ──
    fs.copyFileSync(VERIFY_GD, path.join(dir, "t027_verify.gd"));
    const res = await defaultRunRunner(
      GODOT_BIN!,
      ["--headless", "--path", dir, "--script", path.join(dir, "t027_verify.gd"), "--", "--scene", SCENE],
      { timeoutMs: TIMEOUT_MS },
    );
    const output = `${res.stdout}\n${res.stderr}`;
    const results = res.stdout.split(/\r?\n/).filter((l) => l.startsWith("T027RESULT ")).map((l) => l.slice("T027RESULT ".length));
    console.log(`--- T027 引擎断言原始输出 ---\n${results.join("\n")}`);

    const noisy = output.split(/\r?\n/).filter((l) => /\bERROR\b|\bWARNING\b|SCRIPT ERROR/.test(l));
    assert.deepEqual(noisy, [], `Godot 报错/警告:\n${noisy.join("\n")}`);
    assert.equal(res.exitCode, 0, `Godot 退出码非 0\n${output}`);
    assert.ok(results.includes("ok"), `验证脚本未跑完:\n${res.stdout}\n${res.stderr}`);

    const conns = results.filter((r) => r.startsWith("conn|"));
    assert.ok(conns.includes("conn|Player/Holder/Leaf|tree_exited|.|_on_ready"), `引擎未建立重挂后的连接:\n${conns.join("\n")}`);
  },
);

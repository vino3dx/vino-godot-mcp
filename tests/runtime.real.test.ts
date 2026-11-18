// T4.5:以真实 Godot 为准的复验测试(不依赖 Godot 工程)。
//   1) 读取 tests/fixtures/godot-help.txt,断言 RUNTIME_FLAGS 里每个标志都出现(清单来自 run.ts 常量,避免重复手写)。
//   2) 真实冒烟:GODOT_BIN 存在时用 --headless --version 跑一次,断言退出码 0、流分离、未超时。
// GODOT_BIN 未设置时冒烟测试 skip —— 验收只允许这一类 skip。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunRunner, RUNTIME_FLAGS } from "../src/godot/runtime/run.js";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { RuntimeService } from "../src/services/runtimeService.js";

const HELP_TXT = path.join(import.meta.dirname!, "..", "..", "tests", "fixtures", "godot-help.txt");
const GODOT_BIN = process.env["GODOT_BIN"];

test("RUNTIME_FLAGS 里的每个标志都出现在 godot-help.txt", () => {
  const help = fs.readFileSync(HELP_TXT, "utf8");
  for (const flag of RUNTIME_FLAGS) {
    assert.ok(help.includes(flag), `标志 ${flag} 未出现在 godot-help.txt`);
  }
});

test(
  "smoke: 真实 Godot --headless --version 退出码 0、流分离",
  { skip: GODOT_BIN ? false : "GODOT_BIN 未设置" },
  async () => {
    const res = await defaultRunRunner(GODOT_BIN!, ["--headless", "--version"], { timeoutMs: 30_000 });
    assert.equal(res.exitCode, 0);
    assert.equal(res.timedOut, false);
    assert.equal(res.signal, null);
    // 版本串落在捕获的两个流之一:证明子进程输出进了管道(stdout/stderr 分离捕获),
    // 而非继承本进程 stdout —— 这是"不污染 MCP stdout"的结构性保证。
    // Godot 的版本串是 MAJOR.MINOR[.PATCH].{stable|beta|rc}.{official|custom}.<hash>:
    // patch 为 0 时第三段整体省略(例如 4.6.stable.official.89cea1439),所以不能强制三段式。
    assert.match(res.stdout + res.stderr, /\d+\.\d+(\.\d+)?/);
  },
);

test(
  "real: 截图最小工程并断言 PNG 头与尺寸",
  { skip: GODOT_BIN ? false : "GODOT_BIN 未设置" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-real-shot-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // 最小工程:viewport 640x360 + 带 ColorRect 的场景(截图非 headless,需显示环境)。
    fs.writeFileSync(path.join(dir, "project.godot"), [
      "config_version=5", "",
      "[application]", "", 'config/name="RealShot"', 'run/main_scene="res://main.tscn"', "",
      "[display]", "", "window/size/viewport_width=640", "window/size/viewport_height=360", "",
      "[rendering]", "", 'renderer/rendering_method="gl_compatibility"', 'renderer/rendering_method.mobile="gl_compatibility"',
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "main.tscn"), [
      '[gd_scene format=3]', "",
      '[node name="Main" type="Control"]', 'layout_mode = 3', 'anchors_preset = 15',
      'anchor_right = 1.0', 'anchor_bottom = 1.0', 'grow_horizontal = 2', 'grow_vertical = 2', "",
      '[node name="BG" type="ColorRect" parent="."]', 'layout_mode = 1', 'anchors_preset = 15',
      'anchor_right = 1.0', 'anchor_bottom = 1.0', 'grow_horizontal = 2', 'grow_vertical = 2',
      'color = Color(0.15, 0.4, 0.75, 1)',
    ].join("\n"));
    const project = new ProjectResolver({ cwd: dir });
    const godot = new GodotCliService({ env: { GODOT_PATH: GODOT_BIN } });
    const svc = new RuntimeService({ godot, project, runQueue: new TaskQueue(new LockManager()) });
    // 渲染尺寸 640x360(工程 viewport);缩放输出到 800x450 验证 renderSize 与 outputSize 区分。
    const res = await svc.captureScreenshot({ projectPath: dir, waitFrames: 2, outputWidth: 800, outputHeight: 450, includeImage: false, timeoutMs: 60_000, tool: "runtime_capture_screenshot" });
    const buf = fs.readFileSync(res.filePath);
    // PNG 签名 89 50 4E 47
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(res.outputSize.width, 800);
    assert.equal(res.outputSize.height, 450);
    assert.equal(res.renderSize.width, 640);
    assert.equal(res.renderSize.height, 360);
    fs.rmSync(res.filePath, { force: true });
  },
);

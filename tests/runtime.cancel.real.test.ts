// T07:真实 Godot 引擎上的取消与超时。
//
// 与 Mock 测试的分工:
//   - 这里验证"引擎进程真的被杀掉、锁真的归还、错误码没有混淆";
//   - 传播链路与锁生命周期的细节由 taskQueueCancellation / abortPropagation / runtimeCancellation 覆盖。
// GODOT_BIN 未设置时 skip(与仓库其它 *.real.test.ts 一致)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { RuntimeService } from "../src/services/runtimeService.js";

const GODOT_BIN = process.env["GODOT_BIN"];
const SKIP = GODOT_BIN ? false : "GODOT_BIN 未设置";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 最小可运行工程:主场景只有空节点,不会自己退出(便于观察取消)。 */
function makeProject(t: { after: (fn: () => void) => void }): { dir: string; svc: RuntimeService; locks: LockManager } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-cancel-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), [
    "config_version=5", "",
    "[application]", "", 'config/name="CancelReal"', 'run/main_scene="res://main.tscn"', "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "main.tscn"), ['[gd_scene format=3]', "", '[node name="Main" type="Node"]', ""].join("\n"));
  const locks = new LockManager();
  const svc = new RuntimeService({
    godot: new GodotCliService({ env: { GODOT_PATH: GODOT_BIN } }),
    project: new ProjectResolver({ cwd: dir }),
    runQueue: new TaskQueue(locks),
  });
  return { dir, svc, locks };
}

test("real: 取消正在运行的 Godot → TASK_CANCELLED,进程被杀、项目锁归还", { skip: SKIP }, async (t) => {
  const { dir, svc, locks } = makeProject(t);
  const ctrl = new AbortController();
  const started = Date.now();

  const run = svc.runProject({ projectPath: dir, headless: true, quit: false, timeoutMs: 120_000, signal: ctrl.signal, tool: "runtime_run_project" });
  await wait(2_500); // 冷启动 + 进入主循环
  ctrl.abort(new Error("operator pressed cancel"));

  await assert.rejects(run, (e: unknown) => {
    assert.ok(e instanceof GodotMcpError);
    assert.equal(e.code, "TASK_CANCELLED", "取消不能被报成超时或引擎失败");
    assert.equal(e.details?.["abortSource"], "request");
    const cleanup = e.details?.["cleanup"] as { processExitConfirmed?: boolean; pid?: number };
    assert.equal(cleanup.processExitConfirmed, true, "必须确认 Godot 进程已退出");
    assert.equal(typeof cleanup.pid, "number");
    return true;
  });

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 30_000, `取消应当在杀进程后立即返回,实际耗时 ${elapsed}ms`);
  assert.equal(locks.snapshot().length, 0, "取消后项目锁必须归还");

  // 引擎仍然健康:同一把锁、同一个项目,再跑一次能正常退出。
  const again = await svc.runProject({ projectPath: dir, headless: true, quit: true, timeoutMs: 60_000, tool: "runtime_run_project" });
  assert.equal(again.exitCode, 0);
});

test("real: 超时仍是 TASK_TIMEOUT(与取消严格区分)", { skip: SKIP }, async (t) => {
  const { dir, svc } = makeProject(t);
  await assert.rejects(
    svc.runProject({ projectPath: dir, headless: true, quit: false, timeoutMs: 3_000, tool: "runtime_run_project" }),
    (e: unknown) => {
      assert.ok(e instanceof GodotMcpError);
      assert.equal(e.code, "TASK_TIMEOUT");
      assert.equal(e.details?.["timeoutMs"], 3_000);
      return true;
    },
  );
});

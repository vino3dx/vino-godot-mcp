// T07:真实子进程的终止与退出确认、流监听释放、临时资源清理。
//
// 这里的"真实"指真实的 Node 子进程(不用 mock),但**不是 Godot**:
// 引擎侧的取消行为在 tests/runtime.cancel.real.test.ts,需要 GODOT_BIN。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ProcessAdapter } from "../src/godot/runtime/processAdapter.js";
import { createRunRunner, defaultRunRunner } from "../src/godot/runtime/run.js";
import { withTempScript } from "../src/godot/runtime/scriptRunner.js";
import { TaskCancelledError } from "../src/core/concurrency/cancellation.js";
import { GodotMcpError } from "../src/core/errors.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 进程是否还活着(Windows/Linux 通用:signal 0 只做存在性检查)。 */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

test("取消真实子进程:等进程真的死掉才 reject,pid 与退出确认随错误带出", async () => {
  const ctrl = new AbortController();
  const pending = defaultRunRunner(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 30_000,
    signal: ctrl.signal,
  });
  await wait(150);
  ctrl.abort(new Error("client cancelled"));

  await assert.rejects(pending, (e: unknown) => {
    assert.ok(e instanceof TaskCancelledError, `expected TaskCancelledError, got ${String(e)}`);
    assert.equal(e.code, "TASK_CANCELLED");
    // 取消与超时严格分离:不能报成 TASK_TIMEOUT,也不能报成引擎失败。
    assert.equal(e.details?.["abortSource"], "request");
    const cleanup = e.details?.["cleanup"] as { processExitConfirmed?: boolean; pid?: number };
    assert.equal(cleanup.processExitConfirmed, true, "close 已到达 = 退出已确认");
    assert.equal(typeof cleanup.pid, "number", "pid 必须带出去,否则排查不了残留进程");
    assert.equal(isAlive(cleanup.pid!), false, "子进程必须真的退出,而不是只停止等待");
    return true;
  });
});

test("超时仍然只标 timedOut,不标 aborted", async () => {
  const res = await defaultRunRunner(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 150 });
  assert.equal(res.timedOut, true);
  assert.equal(res.aborted, false);
  assert.equal(res.exitConfirmed, true);
  assert.equal(isAlive(res.pid!), false);
});

test("dispose 之后 stream 监听不再回调(不泄漏 fd / 内存)", async () => {
  const adapter = new ProcessAdapter();
  const handle = adapter.start(process.execPath, ["-e", "let i = 0; setInterval(() => { console.log('tick' + i++); }, 30);"], {});
  let chunks = 0;
  handle.onStdout(() => { chunks += 1; });
  try {
    // 并行跑整套测试时子进程启动可能很慢,不能用固定 200ms 判定"已经收到数据"。
    for (let waited = 0; waited < 5_000 && chunks === 0; waited += 25) await wait(25);
    assert.ok(chunks > 0, "先确认真的收到了数据");

    handle.dispose();
    const frozen = chunks;
    await wait(200);
    assert.equal(chunks, frozen, "dispose 之后不应再有 stdout 回调");
  } finally {
    // 断言失败也必须杀掉子进程:否则它会一直被 setInterval 撑住,挂住整个测试进程。
    await handle.stop("SIGKILL");
    await handle.exited;
  }
});

test("退出无法确认:拒绝并携带 pendingExit / cleanup 诊断,不谎报停干净", async () => {
  // 一个"永远不 close、kill 也不生效"的假子进程:模拟 SIGKILL 之后仍然无法确认退出。
  const fake = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; pid: number; kill: (s?: string) => boolean;
  };
  fake.stdout = new PassThrough();
  fake.stderr = new PassThrough();
  fake.pid = 987_654;
  fake.kill = () => true; // 信号"发出去了",但进程不会退出

  const adapter = new ProcessAdapter(() => fake as unknown as ChildProcess);
  const runner = createRunRunner(adapter);
  const ctrl = new AbortController();
  const pending = runner("fake-godot", [], { timeoutMs: 60_000, signal: ctrl.signal });
  await wait(30);

  // 宽限定时器是 unref 的,测试里需要一个 ref 的把手撑住事件循环。
  const keepAlive = setInterval(() => {}, 20);
  try {
    ctrl.abort(new Error("client cancelled"));
    await assert.rejects(pending, (e: unknown) => {
      assert.ok(e instanceof TaskCancelledError, `expected TaskCancelledError, got ${String(e)}`);
      assert.equal(e.code, "TASK_CANCELLED");
      const cleanup = e.details?.["cleanup"] as { processExitConfirmed: boolean; pid?: number };
      assert.equal(cleanup.processExitConfirmed, false, "无法确认退出时必须如实上报");
      assert.equal(cleanup.pid, fake.pid);
      assert.ok(e.pendingExit instanceof Promise, "必须把 pendingExit 交给上层去延迟放锁");
      return true;
    });
  } finally {
    clearInterval(keepAlive);
  }
  adapter.start("fake-godot", []).dispose();
});

test("withTempScript:任务失败也会删掉临时脚本", async () => {
  let created: string | undefined;
  await assert.rejects(withTempScript("extends Node\n", async (p) => {
    created = p;
    assert.equal(fs.existsSync(p), true);
    throw new GodotMcpError("RUNTIME_FAILED", "boom");
  }), /boom/);
  assert.ok(created !== undefined);
  assert.equal(fs.existsSync(created!), false, "finally 必须删掉临时脚本");
});

test("临时目录里不残留本次任务的截图与脚本", async () => {
  // 只是校验"清理动作本身有效":真实截图路径由 runtimeService 生成,已在 runtimeCancellation 覆盖。
  const dir = path.join(os.tmpdir(), "vino-godot-mcp");
  const before = fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : new Set<string>();
  await withTempScript("extends Node\n", async () => "ok");
  const after = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const leaked = after.filter((name) => name.endsWith(".gd") && !before.has(name));
  assert.deepEqual(leaked, [], "临时 .gd 不应残留");
});

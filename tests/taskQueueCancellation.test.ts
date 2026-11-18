// T07:TaskQueue / LockManager 的取消生命周期。
//
// 这一组全部是 Mock 测试:fn 是手写替身,不启动任何进程。
// 真实引擎的取消行为在 tests/runtime.cancel.real.test.ts,两者不可互相替代。
import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { LockManager, normalizeLockKey } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { TaskCancelledError } from "../src/core/concurrency/cancellation.js";
import { GodotMcpError } from "../src/core/errors.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const who = (tool: string, target = "a.tscn") => ({ tool, target });
const keyOf = (p: string) => `godot-run:${normalizeLockKey(p)}`;
const codeOf = (e: unknown) => (e instanceof GodotMcpError ? e.code : `not-godot-error:${String(e)}`);

test("正常完成:释放锁、清掉 signal 监听、不影响返回值", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  const ctrl = new AbortController();
  const value = await q.runExclusive("/p", who("runtime_run_project"), async () => 42, { signal: ctrl.signal });
  assert.equal(value, 42);
  assert.equal(lm.snapshot().length, 0);
  assert.deepEqual(getEventListeners(ctrl.signal, "abort"), [], "signal 监听必须在任务结束后移除");
});

test("执行中取消:fn 收到 abort,且不允许把'取消后完成'报成成功", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  const ctrl = new AbortController();
  let sawAbort = false;
  let releaseWork!: () => void;

  const running = q.runExclusive("/p", who("runtime_run_project"), async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { sawAbort = true; releaseWork = resolve; }, { once: true });
      // 故意不自动结束:模拟"底层还在收尾",此时取消不得让调用方先看到成功。
      setTimeout(resolve, 60_000).unref();
    });
    return "finished-after-cancel";
  }, { signal: ctrl.signal });

  await wait(5);
  ctrl.abort(new Error("client went away"));
  await wait(5);
  assert.equal(sawAbort, true, "取消信号必须传到 fn 内部");
  assert.equal(lm.snapshot().length, 1, "底层还没结束时锁必须仍然被持有");
  releaseWork();

  await assert.rejects(running, (e: unknown) => codeOf(e) === "TASK_CANCELLED");
  assert.equal(lm.snapshot().length, 0, "取消完成后锁必须释放");
});

test("等待中取消:排队任务不会启动,队列保持健康", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  let releaseHolder!: () => void;
  const holder = q.runExclusive("/p", who("holder"), () => new Promise<void>((r) => { releaseHolder = r; }));
  await wait(5);

  const ctrl = new AbortController();
  let waiterStarted = false;
  const waiter = q.runExclusive("/p", who("waiter"), async () => { waiterStarted = true; }, { signal: ctrl.signal });
  await wait(5);
  ctrl.abort();

  await assert.rejects(waiter, (e: unknown) => codeOf(e) === "TASK_CANCELLED");
  assert.equal(waiterStarted, false, "取消掉的排队任务绝不能启动");

  releaseHolder();
  await holder;
  assert.equal(lm.snapshot().length, 0);

  // 队列仍然可用:下一个任务照常拿到锁。
  const after = await q.runExclusive("/p", who("after"), async () => "ok");
  assert.equal(after, "ok");
});

test("进队列前就已取消:连锁都不碰", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  const ctrl = new AbortController();
  ctrl.abort();
  let called = false;
  await assert.rejects(
    q.runExclusive("/p", who("a"), async () => { called = true; }, { signal: ctrl.signal }),
    (e: unknown) => {
      assert.equal(codeOf(e), "TASK_CANCELLED");
      assert.equal((e as GodotMcpError).details?.["stage"], "queue");
      return true;
    },
  );
  assert.equal(called, false);
  assert.equal(lm.snapshot().length, 0);
});

test("重复取消 / 取消已经完成的任务:幂等且不影响已完成结果", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  const ctrl = new AbortController();
  const done = await q.runExclusive("/p", who("a"), async () => "done", { signal: ctrl.signal });
  ctrl.abort();
  ctrl.abort();
  assert.equal(done, "done", "已完成的任务不能被事后取消改写");
  assert.equal(lm.snapshot().length, 0);

  // 执行中重复 abort:只有第一次生效,错误仍是 TASK_CANCELLED。
  const ctrl2 = new AbortController();
  const p = q.runExclusive("/p", who("b"), (signal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => { ctrl2.abort(); setTimeout(resolve, 5); }, { once: true });
    setTimeout(resolve, 60_000).unref();
  }), { signal: ctrl2.signal });
  await wait(5);
  ctrl2.abort();
  await assert.rejects(p, (e: unknown) => codeOf(e) === "TASK_CANCELLED");
});

test("多任务并发:取消一个不影响另一个", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  const a = new AbortController();
  const pa = q.runExclusive("/a", who("a"), (signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("killed")), { once: true });
  }), { signal: a.signal });
  const pb = q.runExclusive("/b", who("b"), async () => { await wait(30); return "b-done"; });

  a.abort();
  await assert.rejects(pa, (e: unknown) => codeOf(e) === "TASK_CANCELLED");
  assert.equal(await pb, "b-done", "另一个项目的任务不能被串扰");
  assert.equal(lm.snapshot().length, 0);
});

test("进程未确认退出:锁延迟释放到 pendingExit settle", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  let settleExit!: () => void;
  const pendingExit = new Promise<void>((r) => { settleExit = r; });

  const task = q.runExclusive("/p", who("a"), async () => {
    throw new TaskCancelledError("cancelled but process not confirmed dead", {
      operation: "a", stage: "cleanup", abortSource: "request",
      cleanup: { processExitConfirmed: false, pid: 4242, residual: ["pid 4242 still alive"] },
    }, pendingExit);
  });

  await assert.rejects(task, (e: unknown) => {
    assert.equal(codeOf(e), "TASK_CANCELLED");
    assert.deepEqual((e as GodotMcpError).details?.["cleanup"], { processExitConfirmed: false, pid: 4242, residual: ["pid 4242 still alive"] });
    return true;
  });

  // 关键断言:进程未确认退出期间,同项目必须拿不到锁。
  await assert.rejects(
    lm.acquire(keyOf("/p"), who("b"), { timeoutMs: 30 }),
    (e: unknown) => codeOf(e) === "LOCK_TIMEOUT",
  );

  settleExit();
  await wait(0);
  assert.equal(lm.snapshot().length, 0, "pendingExit settle 之后锁必须归还");
  const r = await lm.acquire(keyOf("/p"), who("c"));
  r();
});

test("底层不响应 abort:宽限到点上报清理未完成,且继续持锁", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  const ctrl = new AbortController();
  const p = q.runExclusive("/p", who("a"), () => new Promise<void>(() => {}), { signal: ctrl.signal, cancelGraceMs: 25 });
  await wait(5);
  ctrl.abort();

  // TaskQueue 的宽限定时器是 unref 的(生产环境不该把进程钉住),测试里要用一个 ref 的把手撑住事件循环。
  const keepAlive = setInterval(() => {}, 10);
  try {
    await assert.rejects(p, (e: unknown) => {
      assert.equal(codeOf(e), "TASK_CANCELLED");
      const details = (e as GodotMcpError).details as Record<string, unknown>;
      assert.equal(details["stage"], "cleanup");
      const cleanup = details["cleanup"] as { processExitConfirmed: boolean; residual: string[] };
      assert.equal(cleanup.processExitConfirmed, false);
      assert.ok(cleanup.residual.length > 0, "必须带上残留说明");
      return true;
    });
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(lm.snapshot().length, 1, "底层没停就绝不能放锁");
});

test("超时:仍是 TASK_TIMEOUT,且在底层停下之后才释放锁", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  let fnSettled = false;
  const p = q.runExclusive("/p", who("a"), (signal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => { setTimeout(() => { fnSettled = true; resolve(); }, 10); }, { once: true });
    setTimeout(resolve, 60_000).unref();
  }), { runTimeoutMs: 20 });

  await assert.rejects(p, (e: unknown) => {
    assert.equal(codeOf(e), "TASK_TIMEOUT", "超时不能被改写成取消");
    assert.equal(fnSettled, true, "锁只能在底层真的停下之后释放");
    return true;
  });
  assert.equal(lm.snapshot().length, 0);
});

test("超时之后才到来的取消:不改变本次任务的性质", async () => {
  const lm = new LockManager();
  const q = new TaskQueue(lm);
  const ctrl = new AbortController();
  const p = q.runExclusive("/p", who("a"), (signal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true });
    setTimeout(resolve, 60_000).unref();
  }), { runTimeoutMs: 15, signal: ctrl.signal });

  await wait(18);
  ctrl.abort();
  await assert.rejects(p, (e: unknown) => codeOf(e) === "TASK_TIMEOUT");
});

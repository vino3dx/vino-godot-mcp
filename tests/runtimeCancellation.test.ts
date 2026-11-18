// T07:长任务在服务层的取消传播、导出 staging、截图/ClassDB 清理。
//
// 全部使用注入的 runner 替身(不启动 Godot)。替身遵守与 defaultRunRunner 相同的契约:
// 收到 abort、等底层停下之后再 **reject 一个 TaskCancelledError**(带 cleanup 证据),
// resolve 一律代表成功。契约本身由 tests/cancelCleanup.test.ts 用真实子进程验证。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { TaskCancelledError } from "../src/core/concurrency/cancellation.js";
import { LockManager, normalizeLockKey } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { RuntimeService } from "../src/services/runtimeService.js";
import { ProjectValidationService } from "../src/services/projectValidationService.js";
import { GodotApiService } from "../src/services/godotApiService.js";
import type { GodotRunRunner, RunProcessResult } from "../src/godot/runtime/run.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => (e instanceof GodotMcpError ? e.code : `not-godot-error:${String(e)}`);

const EMPTY: RunProcessResult = {
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
  stdoutTruncated: false, stderrTruncated: false, durationMs: 1, exitConfirmed: true,
};

interface RuntimeCtx { dir: string; locks: LockManager; svc: RuntimeService }

function makeRuntime(t: { after: (fn: () => void) => void }, runner: GodotRunRunner): RuntimeCtx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t07-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");
  const locks = new LockManager();
  return {
    dir, locks,
    svc: new RuntimeService({
      godot: new GodotCliService({ env: { GODOT_PATH: exe } }),
      project: new ProjectResolver({ cwd: dir }),
      runQueue: new TaskQueue(locks),
      runner,
    }),
  };
}

/**
 * 一个"会一直跑"的 runner:收到 abort 后等底层停下,然后按真实契约 reject 取消错误。
 * onStart 用来在"进程运行中"制造副作用(写文件、计数)。
 */
function abortableRunner(
  hooks: { onStart?: (args: readonly string[], signal: AbortSignal | undefined) => void } = {},
): GodotRunRunner {
  return async (_file, args, o) => {
    hooks.onStart?.(args, o.signal);
    if (!o.signal?.aborted) {
      await new Promise<void>((resolve) => {
        o.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 5_000).unref();
      });
    }
    if (o.signal?.aborted) {
      // 与 defaultRunRunner 一致:取消走 reject,pid / 退出确认随错误带出去。
      throw new TaskCancelledError("Godot process (pid 4242) was cancelled and has exited", {
        abortSource: "request", stage: "cleanup", cleanup: { processExitConfirmed: true, pid: 4242 },
      });
    }
    return { ...EMPTY, exitCode: null, signal: "SIGKILL", exitConfirmed: true };
  };
}

test("runProject 运行中取消 → TASK_CANCELLED,子进程确认退出,锁归还", async (t) => {
  let runnerSawAbort: boolean | undefined;
  const { locks, svc } = makeRuntime(t, abortableRunner({
    onStart: (_args, signal) => { signal?.addEventListener("abort", () => { runnerSawAbort = true; }, { once: true }); },
  }));

  const ctrl = new AbortController();
  const run = svc.runProject({ tool: "runtime_run_project", signal: ctrl.signal });
  await wait(15);
  ctrl.abort();

  await assert.rejects(run, (e: unknown) => {
    assert.equal(codeOf(e), "TASK_CANCELLED");
    const cleanup = (e as GodotMcpError).details?.["cleanup"] as { processExitConfirmed?: boolean; pid?: number };
    assert.equal(cleanup.processExitConfirmed, true, "取消回报里必须说明进程已确认退出");
    assert.equal(cleanup.pid, 4242, "pid 不能在传播过程中丢掉(否则无法排查残留进程)");
    assert.equal((e as GodotMcpError).details?.["abortSource"], "request");
    return true;
  });
  assert.equal(runnerSawAbort, true, "取消必须传到实际执行过程");
  assert.equal(locks.snapshot().length, 0);
});

test("排队中取消:根本不会启动 runner", async (t) => {
  let calls = 0;
  const { dir, locks, svc } = makeRuntime(t, async () => { calls += 1; return EMPTY; });

  const release = await locks.acquire(`godot-run:${normalizeLockKey(dir)}`, { tool: "holder", target: "x" });
  const ctrl = new AbortController();
  const run = svc.runProject({ tool: "runtime_run_project", signal: ctrl.signal });
  await wait(10);
  ctrl.abort();
  await assert.rejects(run, (e: unknown) => codeOf(e) === "TASK_CANCELLED");
  assert.equal(calls, 0, "取消掉的排队任务不能启动任何进程");
  release();
});

test("超时仍是 TASK_TIMEOUT,取消是 TASK_CANCELLED(服务层不混用)", async (t) => {
  const timedOut = makeRuntime(t, async () => ({ ...EMPTY, timedOut: true, exitCode: null }));
  await assert.rejects(timedOut.svc.runProject({ tool: "runtime_run_project", timeoutMs: 100 }), (e: unknown) => codeOf(e) === "TASK_TIMEOUT");

  // 兜底:注入的 runner 违约(取消了却 resolve 成功)时,也绝不能被报成成功。
  // 真实 runner 走的是 reject 分支,这条只保证"最坏情况仍不误报"。
  const cancelled = makeRuntime(t, async () => ({ ...EMPTY, aborted: true, exitCode: null }));
  await assert.rejects(cancelled.svc.runProject({ tool: "runtime_run_project" }), (e: unknown) => codeOf(e) === "TASK_CANCELLED");
});

test("导出成功:产物从 staging 提交到正式路径(旧构建此时才被替换)", async (t) => {
  const targetHolder: { stagingPath?: string } = {};
  const { dir, svc } = makeRuntime(t, async (_file, args) => {
    targetHolder.stagingPath = args[5];
    fs.writeFileSync(args[5]!, "NEW-BUILD"); // args[5] = 导出输出路径(staging)
    return { ...EMPTY, stdout: "exported" };
  });
  const target = path.join(dir, "builds", "game.exe");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "OLD-BUILD");

  const res = await svc.exportProject({ tool: "runtime_export_project", preset: "windows", outputPath: target });
  assert.equal(fs.readFileSync(target, "utf8"), "NEW-BUILD");
  assert.equal(res.outputCommitted, true);
  assert.equal(res.outputPath, target);
  // 展示用命令仍然指向用户要求的路径,不把随机 staging 目录漏给用户。
  assert.ok(res.command.endsWith(target), res.command);
  assert.equal(fs.existsSync(path.dirname(targetHolder.stagingPath!)), false, "staging 目录应在提交后清理");
});

test("导出取消:正式路径与旧构建完全不受影响,staging 被清理", async (t) => {
  const seen: { stagingPath?: string } = {};
  const ctrl = new AbortController();
  const { dir, svc } = makeRuntime(t, abortableRunner({
    onStart: (args) => {
      seen.stagingPath = args[5];
      fs.writeFileSync(args[5]!, "PARTIAL"); // 半成品只落在 staging
    },
  }));
  const target = path.join(dir, "builds", "game.exe");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "OLD-BUILD");

  const run = svc.exportProject({ tool: "runtime_export_project", preset: "windows", outputPath: target, signal: ctrl.signal });
  await wait(15);
  ctrl.abort();

  await assert.rejects(run, (e: unknown) => codeOf(e) === "TASK_CANCELLED");
  assert.equal(fs.readFileSync(target, "utf8"), "OLD-BUILD", "取消绝不能动任务开始前就存在的文件");
  assert.ok(seen.stagingPath !== undefined);
  assert.equal(fs.existsSync(path.dirname(seen.stagingPath!)), false, "staging 目录必须被清掉");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["game.exe"], "不能留下任何半成品");
});

test("导出失败:半成品不进正式路径", async (t) => {
  const { dir, svc } = makeRuntime(t, async (_file, args) => {
    fs.writeFileSync(args[5]!, "PARTIAL");
    return { ...EMPTY, exitCode: 1, stderr: "export failed" };
  });
  const target = path.join(dir, "builds", "game.exe");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "OLD-BUILD");

  await assert.rejects(svc.exportProject({ tool: "runtime_export_project", preset: "windows", outputPath: target }), (e: unknown) => codeOf(e) === "GODOT_PROCESS_FAILED");
  assert.equal(fs.readFileSync(target, "utf8"), "OLD-BUILD");
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["game.exe"]);
});

test("截图取消:未交付的 PNG 被删除", async (t) => {
  const ctrl = new AbortController();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  let outPath: string | undefined;
  const { svc } = makeRuntime(t, abortableRunner({
    onStart: (args) => {
      const i = args.indexOf("--out");
      outPath = args[i + 1];
      fs.writeFileSync(outPath!, png); // 进程"已经写出"PNG,然后被取消
    },
  }));

  const run = svc.captureScreenshot({ tool: "runtime_capture_screenshot", signal: ctrl.signal });
  await wait(15);
  ctrl.abort();
  await assert.rejects(run, (e: unknown) => codeOf(e) === "TASK_CANCELLED");
  assert.ok(outPath !== undefined);
  assert.equal(fs.existsSync(outPath!), false, "取消后不应留下没人能拿到的截图");
});

test("project_validate:脚本之间有检查点,取消后不再跑剩余脚本", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t07-validate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");
  for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(dir, `${name}.gd`), "extends Node\n");

  const ctrl = new AbortController();
  let calls = 0;
  const svc = new ProjectValidationService({
    godot: new GodotCliService({ env: { GODOT_PATH: exe } }),
    project: new ProjectResolver({ cwd: dir }),
    runQueue: new TaskQueue(new LockManager()),
    runner: async () => {
      calls += 1;
      ctrl.abort(); // 第一个脚本"运行期间"被取消
      return EMPTY;
    },
  });

  await assert.rejects(svc.validate({ tool: "project_validate", signal: ctrl.signal }), (e: unknown) => codeOf(e) === "TASK_CANCELLED");
  assert.equal(calls, 1, "每个脚本前都会检查取消,不应该继续跑 b/c");
});

test("class_get_info 取消:dump 被中断,缓存目录不留半成品", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t07-classdb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");

  const godot = new GodotCliService({
    env: { GODOT_PATH: exe },
    // 引擎版本探测不走真实进程,否则会去执行那个空 exe。
    runner: async () => ({ stdout: "4.6.3.stable.official.abc123\n", stderr: "" }),
  });
  const api = new GodotApiService({
    godot,
    project: new ProjectResolver({ cwd: dir }),
    runQueue: new TaskQueue(new LockManager()),
    runner: async (_file, args, o) => {
      assert.ok(args.includes("--dump-extension-api"));
      // 在 dump 的工作目录里留下半成品,然后"被取消"。
      fs.writeFileSync(path.join(o.cwd!, "extension_api.json"), "{\"header\":{}");
      return { ...EMPTY, aborted: true, exitCode: null };
    },
  });

  await assert.rejects(api.getClassInfo(dir, "Node"), (e: unknown) => codeOf(e) === "TASK_CANCELLED");
  const cacheDir = path.join(dir, ".vino-godot-mcp", "extension-api");
  assert.equal(fs.existsSync(cacheDir), true);
  assert.deepEqual(fs.readdirSync(cacheDir), [], "取消后缓存目录里不能有 extension_api.json 半成品");
});

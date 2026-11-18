// Stage 4 / T4:runtime_run_project / runtime_run_scene / runtime_export_project 的单元与集成测试。
// 分层验证:纯参数构建 → 真实 spawn(用 node 而非 Godot,绝不启动 Godot)→ 服务层(注入 runner)→ 工具层(经 ToolHost)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { createLogger } from "../src/core/logger.js";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import {
  buildExportArgs,
  buildRunArgs,
  defaultRunRunner,
  type GodotRunRunner,
  type RunProcessResult,
} from "../src/godot/runtime/run.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { RuntimeService } from "../src/services/runtimeService.js";
import { runtimeRunProject } from "../src/tools/runtime/runProject.js";
import { runtimeRunScene } from "../src/tools/runtime/runScene.js";
import { runtimeExportProject } from "../src/tools/runtime/exportProject.js";
import type { AppContext } from "../src/services/context.js";

const quiet = createLogger("error", () => {});

function okRunner(result: Partial<RunProcessResult> = {}): GodotRunRunner {
  return async () => ({
    exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 5,
    ...result,
  });
}

function recordingRunner(
  result: Partial<RunProcessResult>,
  log: Array<{ file: string; args: readonly string[]; timeoutMs: number }>,
): GodotRunRunner {
  return async (file, args, opts) => {
    log.push({ file, args, timeoutMs: opts.timeoutMs });
    return {
      exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
      stdoutTruncated: false, stderrTruncated: false, durationMs: 5,
      ...result,
    };
  };
}

function makeRuntime(
  t: { after: (fn: () => void) => void },
  runner: GodotRunRunner,
): { dir: string; exe: string; svc: RuntimeService } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: exe } });
  const svc = new RuntimeService({ godot, project, runQueue: new TaskQueue(new LockManager()), runner });
  return { dir, exe, svc };
}

// ---------- 纯参数构建 ----------

test("buildRunArgs: --path 在前,场景经 --scene 传入,headless/quit/extra 正确", () => {
  assert.deepEqual(
    buildRunArgs("/proj", { headless: true, quit: true, scene: "res://main.tscn" }),
    ["--path", "/proj", "--headless", "--quit", "--scene", "res://main.tscn"],
  );
  assert.deepEqual(buildRunArgs("/proj", { headless: false, quit: false }), ["--path", "/proj"]);
  assert.deepEqual(
    buildRunArgs("/proj", { headless: true, quit: false, extraArgs: ["--verbose"], scene: "a.tscn" }),
    ["--path", "/proj", "--headless", "--verbose", "--scene", "a.tscn"],
  );
});

test("buildExportArgs: release/debug 与 preset/outputPath(path 必填)", () => {
  assert.deepEqual(
    buildExportArgs("/proj", { preset: "linux", mode: "release", headless: true, outputPath: "build/game.exe" }),
    ["--path", "/proj", "--headless", "--export-release", "linux", "build/game.exe"],
  );
  assert.deepEqual(
    buildExportArgs("/proj", { preset: "web", mode: "debug", headless: false, outputPath: "out/" }),
    ["--path", "/proj", "--export-debug", "web", "out/"],
  );
});

// ---------- 真实 spawn(用 node,不启动 Godot) ----------

test("defaultRunRunner: 真实 spawn 分离 stdout/stderr 并捕获退出码", async () => {
  const res = await defaultRunRunner(
    process.execPath,
    ["-e", "process.stdout.write('OUT'); process.stderr.write('ERR');"],
    { timeoutMs: 5000 },
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.stdout, "OUT");
  assert.equal(res.stderr, "ERR");
});

test("defaultRunRunner: 非零退出码原样捕获", async () => {
  const res = await defaultRunRunner(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 5000 });
  assert.equal(res.exitCode, 3);
  assert.equal(res.signal, null);
});

test("defaultRunRunner: 超时 SIGKILL(exitCode 为 null)", async () => {
  const res = await defaultRunRunner(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200 });
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
});

test("defaultRunRunner: 超过捕获上限截断但进程仍正常退出", async () => {
  const res = await defaultRunRunner(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(300000), () => process.exit(0))"],
    { timeoutMs: 5000 },
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdoutTruncated, true);
});

// ---------- 服务层(注入 runner) ----------

test("runProject 成功:命令/来源/项目根/日志透传,默认 headless+quit", async (t) => {
  const log: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
  const { dir, exe, svc } = makeRuntime(t, recordingRunner({ stdout: "hi", stderr: "warn", durationMs: 9 }, log));
  const res = await svc.runProject({ tool: "runtime_run_project", scene: "res://main.tscn" });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "hi");
  assert.equal(res.stderr, "warn");
  assert.equal(res.source, "GODOT_PATH");
  assert.equal(res.resolvedPath, exe);
  assert.equal(res.projectDir, dir);
  assert.equal(log[0]?.file, exe);
  assert.deepEqual(log[0]?.args, ["--path", dir, "--headless", "--quit", "--scene", "res://main.tscn"]);
  assert.equal(log[0]?.timeoutMs, 30_000);
});

test("runProject 非零退出码 → GODOT_PROCESS_FAILED,细节带日志", async (t) => {
  const { svc } = makeRuntime(t, okRunner({ exitCode: 1, stderr: "boom" }));
  await assert.rejects(svc.runProject({ tool: "runtime_run_project" }), (e: unknown) => {
    assert.ok(e instanceof GodotMcpError);
    assert.equal(e.code, "GODOT_PROCESS_FAILED");
    assert.equal(e.details?.["exitCode"], 1);
    assert.equal(e.details?.["stderr"], "boom");
    return true;
  });
});

test("runProject 超时 → TASK_TIMEOUT", async (t) => {
  const { svc } = makeRuntime(t, okRunner({ timedOut: true, exitCode: null }));
  await assert.rejects(svc.runProject({ tool: "runtime_run_project", timeoutMs: 250 }), (e: unknown) => {
    assert.ok(e instanceof GodotMcpError);
    assert.equal(e.code, "TASK_TIMEOUT");
    assert.equal(e.details?.["timeoutMs"], 250);
    return true;
  });
});

test("exportProject 构建导出参数(mode=debug),产物先落 staging 再提交", async (t) => {
  const log: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
  const { dir, svc } = makeRuntime(t, recordingRunner({}, log));
  await svc.exportProject({ tool: "runtime_export_project", preset: "windows", mode: "debug", outputPath: "build/game.exe" });
  const args = log[0]?.args ?? [];
  // 前 4 项是项目与模式标志,T07 之后输出路径指向任务专属 staging(系统临时目录),不再直写正式路径。
  assert.deepEqual(args.slice(0, 5), ["--path", dir, "--headless", "--export-debug", "windows"]);
  const stagingOut = args[5]!;
  assert.ok(path.isAbsolute(stagingOut), `export path should be absolute staging path, got ${stagingOut}`);
  assert.ok(stagingOut.startsWith(os.tmpdir()), `export path should live under the temp dir, got ${stagingOut}`);
  assert.equal(path.basename(stagingOut), "game.exe");
  // 正式路径在导出成功前不应被创建/覆盖。
  assert.equal(fs.existsSync(path.join(dir, "build", "game.exe")), false);
});

test("GODOT_PATH 指向不存在文件 → GODOT_NOT_FOUND", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-runtime-missing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: path.join(dir, "nope.exe") } });
  const svc = new RuntimeService({ godot, project, runQueue: new TaskQueue(new LockManager()), runner: okRunner() });
  await assert.rejects(svc.runProject({ tool: "runtime_run_project" }), (e: unknown) => {
    assert.ok(e instanceof GodotMcpError);
    assert.equal(e.code, "GODOT_NOT_FOUND");
    return true;
  });
});

// ---------- 工具层(经 ToolHost) ----------

test("runtime 工具经 ToolHost:成功信封 + 必填/枚举参数校验", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-runtime-host-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: exe } });
  const runtime = new RuntimeService({
    godot, project, runQueue: new TaskQueue(new LockManager()), runner: okRunner({ stdout: "ok" }),
  });
  const ctx = { runtime } as unknown as AppContext;
  const host = new ToolHost(
    new ToolRegistry<AppContext>().registerAll([runtimeRunProject, runtimeRunScene, runtimeExportProject]),
    ctx, quiet,
  );

  const okRun = await host.callTool("runtime_run_project", {});
  assert.equal(okRun.ok, true);
  assert.equal((okRun as { ok: true; data: { stdout: string } }).data.stdout, "ok");

  const runScene = await host.callTool("runtime_run_scene", { scene: "res://a.tscn" });
  assert.equal(runScene.ok, true);

  const missingScene = await host.callTool("runtime_run_scene", {});
  assert.equal(missingScene.ok, false);
  assert.equal((missingScene as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");

  const noPreset = await host.callTool("runtime_export_project", {});
  assert.equal(noPreset.ok, false);
  assert.equal((noPreset as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");

  // outputPath 必填:缺少时应返回校验错误,而不是进入 Godot 调用
  const missingPath = await host.callTool("runtime_export_project", { preset: "p" });
  assert.equal(missingPath.ok, false);
  assert.equal((missingPath as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");

  const badMode = await host.callTool("runtime_export_project", { preset: "p", outputPath: "out/game.exe", mode: "staging" });
  assert.equal(badMode.ok, false);
  assert.equal((badMode as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");

  // outputPath 齐备时成功
  const okExport = await host.callTool("runtime_export_project", { preset: "p", outputPath: "out/game.exe" });
  assert.equal(okExport.ok, true);
});

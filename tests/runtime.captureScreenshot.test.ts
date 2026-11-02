// T5:runtime_capture_screenshot 的单元测试(mock 进程,不依赖真实 Godot)。
// 分层:纯函数(参数构建 / renderSize 解析 / PNG 头)→ 服务层(注入 runner)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import type { GodotRunRunner } from "../src/godot/runtime/run.js";
import {
  buildScreenshotArgs,
  isPng,
  parseRenderSize,
  readPngSize,
} from "../src/godot/runtime/screenshot.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { RuntimeService } from "../src/services/runtimeService.js";
import { runtimeCaptureScreenshot } from "../src/tools/runtime/captureScreenshot.js";
import { createLogger } from "../src/core/logger.js";
import type { AppContext } from "../src/services/context.js";

const quiet = createLogger("error", () => {});

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 构造仅含头部的 PNG(满足 isPng + readPngSize 读取)。 */
function makePng(width: number, height: number, extraBytes = 0): Buffer {
  const buf = Buffer.alloc(24 + extraBytes);
  PNG_SIG.copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

interface RunnerOpts {
  stdout?: string;
  exitCode?: number;
  /** 是否写 PNG 到 --out 路径;默认 true。 */
  writeFile?: boolean;
  /** 写的 PNG 尺寸;默认 1280x720。 */
  pngSize?: { w: number; h: number };
  /** 自定义写入字节(覆盖 pngSize)。 */
  fileBytes?: Buffer;
}

function pngRunner(opts: RunnerOpts = {}): GodotRunRunner {
  return async (_file, args) => {
    const outIdx = args.indexOf("--out");
    const outPath = outIdx >= 0 ? (args[outIdx + 1] as string) : undefined;
    if (opts.writeFile !== false && outPath) {
      const bytes = opts.fileBytes ?? makePng(opts.pngSize?.w ?? 1280, opts.pngSize?.h ?? 720);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, bytes);
    }
    return {
      exitCode: opts.exitCode ?? 0, signal: null, timedOut: false,
      stdout: opts.stdout ?? "SCREENSHOT_RENDER_SIZE=1280x720\n",
      stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 5,
    };
  };
}

function makeRuntime(t: { after: (fn: () => void) => void }, runner: GodotRunRunner): { dir: string; exe: string; svc: RuntimeService } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-shot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: exe } });
  const svc = new RuntimeService({ godot, project, runQueue: new TaskQueue(new LockManager()), runner });
  return { dir, exe, svc };
}

// ---------- 纯函数 ----------

test("buildScreenshotArgs: 固定参数 + 可选 scene/width/height", () => {
  assert.deepEqual(
    buildScreenshotArgs("/proj", { scriptPath: "/tmp/s.gd", outPath: "/tmp/o.png", waitFrames: 3 }),
    ["--path", "/proj", "--script", "/tmp/s.gd", "--", "--out", "/tmp/o.png", "--frames", "3"],
  );
  assert.deepEqual(
    buildScreenshotArgs("/proj", { scriptPath: "/tmp/s.gd", outPath: "/tmp/o.png", waitFrames: 5, scene: "res://a.tscn", outputWidth: 800, outputHeight: 450 }),
    ["--path", "/proj", "--script", "/tmp/s.gd", "--", "--out", "/tmp/o.png", "--frames", "5", "--scene", "res://a.tscn", "--width", "800", "--height", "450"],
  );
});

test("parseRenderSize: 命中返回尺寸,未命中返回 null", () => {
  assert.deepEqual(parseRenderSize("foo\nSCREENSHOT_RENDER_SIZE=1280x720\n"), { width: 1280, height: 720 });
  assert.equal(parseRenderSize("no marker"), null);
});

test("isPng / readPngSize: 签名与宽高", () => {
  const png = makePng(1920, 1080);
  assert.equal(isPng(png), true);
  assert.deepEqual(readPngSize(png), { width: 1920, height: 1080 });
  const notPng = Buffer.alloc(32, 1);
  assert.equal(isPng(notPng), false);
  const short = Buffer.from([0x89, 0x50]);
  assert.equal(isPng(short), false);
});

// ---------- 服务层(注入 runner) ----------

test("captureScreenshot 成功:返回路径/尺寸/大小/耗时,脚本被清理", async (t) => {
  const { dir, svc } = makeRuntime(t, pngRunner());
  const res = await svc.captureScreenshot({ tool: "runtime_capture_screenshot", includeImage: false });
  assert.equal(res.renderSize.width, 1280);
  assert.equal(res.renderSize.height, 720);
  assert.deepEqual(res.outputSize, { width: 1280, height: 720 });
  assert.equal(res.fileSize, 24);
  assert.ok(res.filePath.startsWith(path.join(os.tmpdir(), "vino-godot-mcp", "screenshots")));
  assert.ok(fs.existsSync(res.filePath));
  assert.equal(res.imageBase64, undefined);
  // 脚本文件已清理:临时目录下不应残留 capture-*.gd
  const scriptDir = path.join(os.tmpdir(), "vino-godot-mcp");
  const leftovers = fs.readdirSync(scriptDir).filter((f) => f.startsWith("capture-") && f.endsWith(".gd"));
  assert.deepEqual(leftovers, []);
  // 命令串包含 --script 与 -- 分隔符
  assert.match(res.command, /--script .* -- --out/);
  assert.equal(res.source, "GODOT_PATH");
  assert.equal(res.projectDir, dir);
});

test("captureScreenshot: includeImage 时返回 base64", async (t) => {
  const { svc } = makeRuntime(t, pngRunner());
  const res = await svc.captureScreenshot({ tool: "runtime_capture_screenshot", includeImage: true });
  assert.equal(res.imageBase64, makePng(1280, 720).toString("base64"));
});

test("captureScreenshot: 超过 1MB 不内联 base64", async (t) => {
  const big = makePng(1280, 720, 1024 * 1024);
  const { svc } = makeRuntime(t, pngRunner({ fileBytes: big }));
  const res = await svc.captureScreenshot({ tool: "runtime_capture_screenshot", includeImage: true });
  assert.equal(res.imageBase64, undefined);
  assert.equal(res.fileSize, big.length);
});

test("captureScreenshot: 场景 load 失败(exit 2)→ FILE_NOT_FOUND", async (t) => {
  const { svc } = makeRuntime(t, pngRunner({ exitCode: 2, writeFile: false, stdout: "ERROR: SCREENSHOT_SCENE_LOAD_FAILED" }));
  await assert.rejects(
    svc.captureScreenshot({ tool: "runtime_capture_screenshot", scene: "res://nope.tscn" }),
    (e: unknown) => {
      assert.ok(e instanceof GodotMcpError);
      assert.equal(e.code, "FILE_NOT_FOUND");
      assert.equal(e.details?.["scene"], "res://nope.tscn");
      return true;
    },
  );
});

test("captureScreenshot: 超时 → TASK_TIMEOUT", async (t) => {
  const timedOutRunner: GodotRunRunner = async () => ({
    exitCode: null, signal: null, timedOut: true, stdout: "", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 5,
  });
  const { svc } = makeRuntime(t, timedOutRunner);
  await assert.rejects(
    svc.captureScreenshot({ tool: "runtime_capture_screenshot", timeoutMs: 250 }),
    (e: unknown) => e instanceof GodotMcpError && e.code === "TASK_TIMEOUT",
  );
});

test("captureScreenshot: 进程成功但无输出文件 → RUNTIME_FAILED", async (t) => {
  const { svc } = makeRuntime(t, pngRunner({ writeFile: false }));
  await assert.rejects(
    svc.captureScreenshot({ tool: "runtime_capture_screenshot" }),
    (e: unknown) => e instanceof GodotMcpError && e.code === "RUNTIME_FAILED",
  );
});

test("captureScreenshot: 输出不是 PNG → RUNTIME_FAILED", async (t) => {
  const { svc } = makeRuntime(t, pngRunner({ fileBytes: Buffer.alloc(64, 0x42) }));
  await assert.rejects(
    svc.captureScreenshot({ tool: "runtime_capture_screenshot" }),
    (e: unknown) => e instanceof GodotMcpError && e.code === "RUNTIME_FAILED",
  );
});

// ---------- 工具层(经 ToolHost) ----------

test("runtime_capture_screenshot 经 ToolHost:成对校验 + 成功信封含 image 块", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-shot-host-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), "");
  const exe = path.join(dir, "godot.exe");
  fs.writeFileSync(exe, "");
  const project = new ProjectResolver({ cwd: dir });
  const godot = new GodotCliService({ env: { GODOT_PATH: exe } });
  const runtime = new RuntimeService({
    godot, project, runQueue: new TaskQueue(new LockManager()), runner: pngRunner(),
  });
  const ctx = { runtime } as unknown as AppContext;
  const host = new ToolHost(
    new ToolRegistry<AppContext>().registerAll([runtimeCaptureScreenshot]),
    ctx, quiet,
  );

  const ok = await host.callTool("runtime_capture_screenshot", { includeImage: true });
  assert.equal(ok.ok, true);
  const data = (ok as { ok: true; data: { filePath: string; outputSize: { width: number }; fileSize: number } }).data;
  assert.match(data.filePath, /vino-godot-mcp[/\\]screenshots/);
  assert.equal(data.outputSize.width, 1280);
  assert.equal(data.fileSize, 24);
  assert.equal((ok as { ok: true; image?: { mimeType: string } }).image?.mimeType, "image/png");

  // outputWidth 单独给 → INVALID_ARGUMENT
  const bad = await host.callTool("runtime_capture_screenshot", { outputWidth: 800 });
  assert.equal(bad.ok, false);
  assert.equal((bad as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");
});

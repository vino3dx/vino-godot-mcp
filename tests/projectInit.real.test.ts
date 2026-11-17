// T028 真实引擎验证:project_init 的产物必须能被本机真实 Godot 4.x 直接加载。
//
// 约定与其它 *.real.test.ts 一致:只读环境变量 GODOT_BIN(测试授权路径),其次 GODOT_PATH;
// 两者都没有时整组 skip,绝不用 mock 冒充引擎结论。产物全部落在 mkdtemp() 的临时目录里。
//
// 两层证据:
//   1) `--headless --quit` 退出码必须为 0(工程能被引擎打开);
//   2) 把 tests/fixtures/t28_verify_settings.gd 复制进去用 `--script` 执行,由**引擎自己**
//      回读 ProjectSettings,证明写进 project.godot 的 name / main_scene / renderer 真的生效。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../src/core/logger.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createAppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";
import type { AppContext } from "../src/services/context.js";

const execFileAsync = promisify(execFile);
const GODOT = process.env["GODOT_BIN"] ?? process.env["GODOT_PATH"];
const skip = GODOT ? false : "GODOT_BIN / GODOT_PATH 未设置";
const quiet = createLogger("error", () => {});

const VERIFY_GD = path.join(import.meta.dirname!, "..", "..", "tests", "fixtures", "t28_verify_settings.gd");
const VERIFY_RES = "res://t28_verify_settings.gd";

interface Harness { target: string; host: ToolHost<AppContext> }

function makeHarness(t: { after: (fn: () => void) => void }): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-init-real-"));
  t.after(() => {
    if (process.env["T28_KEEP"] === "1") {
      console.log(`T28 temp dir kept: ${base}`);
      return;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const target = path.join(base, "bootstrapped");
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: base }));
  return { target, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function ok(r: ToolResult): Record<string, unknown> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; data: unknown }).data as Record<string, unknown>;
}

/** 跑一次引擎:失败也不抛(退出码由调用方断言),方便把 stdout/stderr 一起写进断言消息。 */
async function runGodot(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(GODOT!, args, { cwd, windowsHide: true, timeout: 120_000, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const error = e as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    return {
      code: typeof error.code === "number" ? error.code : null,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

/** 让引擎自己回读 ProjectSettings(而不是相信我们写的文本)。 */
async function readBackSettings(target: string): Promise<Record<string, string>> {
  fs.copyFileSync(VERIFY_GD, path.join(target, "t28_verify_settings.gd"));
  const run = await runGodot(["--headless", "--path", target, "--script", VERIFY_RES], target);
  assert.equal(run.code, 0, `引擎执行校验脚本失败(exit=${run.code})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const out: Record<string, string> = {};
  for (const line of run.stdout.split(/\r?\n/)) {
    const match = /^T28_([A-Z]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

test("真实引擎:project_init 默认产物可被 godot --headless 直接加载(退出码 0)", { skip, timeout: 180_000 }, async (t) => {
  const { target, host } = makeHarness(t);
  ok(await host.callTool("project_init", { projectPath: target, projectName: "Headless Bootstrap" }));

  const run = await runGodot(["--headless", "--path", target, "--quit"], target);
  assert.equal(run.code, 0, `godot 加载初始化工程失败(exit=${run.code})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.doesNotMatch(run.stderr, /Unable to load project|not a Godot project|Couldn't load project/i);

  const settings = await readBackSettings(target);
  assert.equal(settings["NAME"], "Headless Bootstrap");
  assert.equal(settings["MAIN"], "res://main.tscn");
  assert.equal(settings["RENDERER"], "forward_plus");

  // 引擎加载后工程头仍然完好(没有被判成损坏工程清空)。
  const projectGodot = fs.readFileSync(path.join(target, "project.godot"), "utf8");
  assert.ok(projectGodot.includes("config_version=5"));
  assert.ok(projectGodot.includes('run/main_scene="res://main.tscn"'));
});

test("真实引擎:gl_compatibility + 自定义主场景同样可加载(退出码 0)", { skip, timeout: 180_000 }, async (t) => {
  const { target, host } = makeHarness(t);
  ok(await host.callTool("project_init", {
    projectPath: target,
    projectName: "Compat Bootstrap",
    renderer: "gl_compatibility",
    mainScene: "res://levels/start.tscn",
  }));

  const run = await runGodot(["--headless", "--path", target, "--quit"], target);
  assert.equal(run.code, 0, `godot 加载 gl_compatibility 工程失败(exit=${run.code})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);

  const settings = await readBackSettings(target);
  assert.equal(settings["NAME"], "Compat Bootstrap");
  assert.equal(settings["MAIN"], "res://levels/start.tscn");
  assert.equal(settings["RENDERER"], "gl_compatibility");
  assert.ok(fs.existsSync(path.join(target, "levels", "start.tscn")));
});

// P1-A 降级路径:ClassDB 不可用时写入仍可用,但必须明确报告 validation unavailable,
// 不能把"没校验"伪装成"校验通过"。真实引擎校验见 classValidation.real.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { GodotApiService } from "../src/services/godotApiService.js";
import { GodotCliService } from "../src/services/godotCli.js";
import { createAppContext, type AppContext } from "../src/services/context.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";

const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");
const quiet = createLogger("error", () => {});

function makeHost(t: { after: (fn: () => void) => void }): { dir: string; host: ToolHost<AppContext> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-classval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const project = new ProjectResolver({ cwd: dir });
  const ctx = createAppContext(quiet, project);
  // 强制 ClassDB 不可用:空环境 + 空 PATH,不依赖开发机是否装了 Godot。
  ctx.godotApi = new GodotApiService({
    godot: new GodotCliService({ env: {} }),
    project,
    runQueue: new TaskQueue(new LockManager()),
  });
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

test("scene_add_node still works without ClassDB and reports validation unavailable", async (t) => {
  const { dir, host } = makeHost(t);
  const r = await host.callTool("scene_add_node", {
    path: "res://scenes/main.tscn",
    parentPath: ".",
    nodeType: "Control",
    nodeName: "Hud",
    properties: [{ name: "offset_left", value: "12.0" }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const data = (r as { ok: true; data: Record<string, unknown> }).data;
  const validation = data["propertyValidation"] as Record<string, unknown>;
  assert.equal(validation["status"], "unavailable");
  assert.equal(validation["source"], "none");
  assert.equal(data["validationSource"], "none");
  assert.equal((r as { warnings?: string[] }).warnings, undefined, "no fake warnings when nothing was checked");
  assert.ok(fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8").includes('name="Hud"'));
});

test("scene_update_node_property reports unavailable validation without blocking the edit", async (t) => {
  const { dir, host } = makeHost(t);
  const r = await host.callTool("scene_update_node_property", {
    path: "res://scenes/main.tscn", nodePath: "Player", key: "position", value: "Vector2(1, 2)",
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const data = (r as { ok: true; data: Record<string, unknown> }).data;
  assert.equal((data["propertyValidation"] as Record<string, unknown>)["status"], "unavailable");
  assert.equal(data["validationSource"], "none");
  assert.ok(fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8").includes("position = Vector2(1, 2)"));
});

test("scene_set_ui_layout rejects unknown layout keys with INVALID_ARGUMENT", async (t) => {
  const { host } = makeHost(t);
  const r = await host.callTool("scene_set_ui_layout", {
    path: "res://scenes/main.tscn", nodePath: "Player", layout: { not_a_layout_key: "1" },
  }) as ToolResult;
  assert.equal(r.ok, false);
  assert.equal((r as { ok: false; error: { code: string } }).error.code, "INVALID_ARGUMENT");
});

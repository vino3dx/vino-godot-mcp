// T1:统一权限体系测试。
//
// 分两层:
//   A. 策略层(合成工具,毫秒级):只读拦截、confirm 门槛、dryRun/preview 豁免、env 解析。
//   B. 真实工具层(临时工程夹具):证明闸门在 handler 之前 —— 被拒绝时文件字节不变、
//      bridge 写入根本没发起;合法调用在 confirm 后照常完成业务。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { createPermissionPolicy, parseReadOnly, permissionPolicyFromEnv, isNonExecutingCall, READ_ONLY_ENV } from "../src/core/permissions.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { createAppContext, type AppContext } from "../src/services/context.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { buildHost } from "../src/index.js";
import { allTools } from "../src/tools/index.js";
import type { ToolDefinition, ToolResult } from "../src/types/index.js";

const quiet = createLogger("error", () => {});
const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");

// ────────────────────────────── A. 策略层 ──────────────────────────────

function tool(name: string, annotations: ToolDefinition["annotations"], handler?: ToolDefinition["handler"]): ToolDefinition {
  return {
    name, domain: "utility", description: "d", annotations, dependency: "none", runtimeRequired: false,
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" }, dryRun: { type: "boolean" }, mode: { type: "string" }, x: { type: "number" } } },
    handler: handler ?? (async () => ({ data: "executed" })),
  };
}

function counting(): { hits: () => number; handler: ToolDefinition["handler"] } {
  let n = 0;
  return { hits: () => n, handler: async () => { n += 1; return { data: "executed" }; } };
}

test("parseReadOnly: 真值/假值/非法值", () => {
  for (const v of ["1", "true", "TRUE", " yes ", "on"]) assert.equal(parseReadOnly(v), true, v);
  for (const v of [undefined, "", "0", "false", "no", "off"]) assert.equal(parseReadOnly(v), false, String(v));
  assert.throws(() => parseReadOnly("maybe"), (e: unknown) => (e as { code: string }).code === "INVALID_CONFIGURATION");
});

test("permissionPolicyFromEnv 只读 + 默认写权限", () => {
  assert.equal(permissionPolicyFromEnv({}).readOnly, false, "未设置时保持旧行为");
  assert.equal(permissionPolicyFromEnv({ [READ_ONLY_ENV]: "true" }).readOnly, true);
  assert.throws(() => permissionPolicyFromEnv({ [READ_ONLY_ENV]: "ture" }), /Invalid VINO_GODOT_MCP_READ_ONLY/);
});

test("isNonExecutingCall: dryRun / mode=preview 才算只出计划", () => {
  assert.equal(isNonExecutingCall({ dryRun: true }), true);
  assert.equal(isNonExecutingCall({ mode: "preview" }), true);
  assert.equal(isNonExecutingCall({ mode: "commit" }), false);
  assert.equal(isNonExecutingCall({ dryRun: false }), false);
  assert.equal(isNonExecutingCall({}), false);
});

test("只读模式:写工具被拒且 handler 一次都没执行", async () => {
  const c = counting();
  const h = new ToolHost(new ToolRegistry().registerAll([
    tool("utility_write", { readOnly: false }, c.handler),
    tool("utility_read", { readOnly: true }),
  ]), {}, quiet, undefined, createPermissionPolicy({ readOnly: true }));

  const w = await h.callTool("utility_write", {});
  assert.equal(w.ok, false);
  assert.equal((w as { error: { code: string } }).error.code, "READ_ONLY");
  assert.equal(c.hits(), 0, "handler 不得被调用");

  const r = await h.callTool("utility_read", {});
  assert.equal(r.ok, true, "只读工具在只读模式下必须照常工作");
});

test("只读模式优先于参数校验:坏参数也返回 READ_ONLY", async () => {
  const h = new ToolHost(new ToolRegistry().registerAll([tool("utility_write", { readOnly: false })]), {}, quiet, undefined, createPermissionPolicy({ readOnly: true }));
  const r = await h.callTool("utility_write", { x: "not-a-number" });
  assert.equal((r as { error: { code: string } }).error.code, "READ_ONLY");
});

test("高危操作:缺 confirm 被拒,confirm=true 放行,预览豁免", async () => {
  const c = counting();
  const h = new ToolHost(new ToolRegistry().registerAll([tool("utility_danger", { readOnly: false, destructive: true }, c.handler)]), {}, quiet);

  const missing = await h.callTool("utility_danger", {});
  assert.equal((missing as { error: { code: string } }).error.code, "CONFIRMATION_REQUIRED");
  assert.equal(c.hits(), 0);

  const explicitFalse = await h.callTool("utility_danger", { confirm: false });
  assert.equal((explicitFalse as { error: { code: string } }).error.code, "CONFIRMATION_REQUIRED");

  assert.equal((await h.callTool("utility_danger", { confirm: true })).ok, true);
  assert.equal(c.hits(), 1);

  assert.equal((await h.callTool("utility_danger", { dryRun: true })).ok, true, "dryRun 只出计划,不需要确认");
  assert.equal((await h.callTool("utility_danger", { mode: "preview" })).ok, true, "mode=preview 同上");
  assert.equal((await h.callTool("utility_danger", { mode: "commit" })).ok, false, "mode=commit 仍要确认");
  assert.equal(c.hits(), 3);
});

test("只读 + 高危:先报 READ_ONLY(权限顺序)", async () => {
  const h = new ToolHost(new ToolRegistry().registerAll([tool("utility_danger", { readOnly: false, destructive: true })]), {}, quiet, undefined, createPermissionPolicy({ readOnly: true }));
  const r = await h.callTool("utility_danger", {});
  assert.equal((r as { error: { code: string } }).error.code, "READ_ONLY");
});

test("buildHost 从 env 装配权限,并给出可读摘要", () => {
  const ro = buildHost(quiet, { VINO_GODOT_MCP_PRESET: "full", [READ_ONLY_ENV]: "true" });
  assert.match(ro.permissionSummary(), /read-only=true/);
  const rw = buildHost(quiet, { VINO_GODOT_MCP_PRESET: "full" });
  assert.match(rw.permissionSummary(), /read-only=false/);
});

// ────────────────────────────── B. 真实工具层 ──────────────────────────────

interface Fixture { dir: string; chain: () => string; file: string; host: ToolHost<AppContext> }

function makeHost(t: { after: (fn: () => void) => void }, readOnly: boolean): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godot-mcp-t1-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  const host = new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet, undefined, createPermissionPolicy({ readOnly }));
  return { dir, host, file: path.join(dir, "scenes", "main.tscn"), chain: () => fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8") };
}

const codeOf = (r: ToolResult): string => (r.ok ? "OK" : (r as { error: { code: string } }).error.code);

test("只读模式:scene_remove_node 被拒且 .tscn 字节不变", async (t) => {
  const f = makeHost(t, true);
  const before = f.chain();
  const r = await f.host.callTool("scene_remove_node", { path: "res://scenes/main.tscn", nodePath: "Player", confirm: true });
  assert.equal(codeOf(r), "READ_ONLY");
  assert.equal(f.chain(), before, "只读模式绝不能改动文件");
});

test("只读模式:editor_remove_node(Editor Bridge 写入)被拒,且未发起 bridge 调用", async (t) => {
  const f = makeHost(t, true);
  // 夹具里没有运行中的 Editor,若闸门失效会走到 bridge 并报 BRIDGE_UNAVAILABLE —— 断言 READ_ONLY 即证明闸门在 handler 之前。
  const r = await f.host.callTool("editor_remove_node", { nodePath: "World/Environment", confirm: true });
  assert.equal(codeOf(r), "READ_ONLY");
});

test("只读模式:查询工具照常可用", async (t) => {
  const f = makeHost(t, true);
  const tree = await f.host.callTool("scene_get_tree", { path: "res://scenes/main.tscn" });
  assert.equal(tree.ok, true, JSON.stringify(tree));
  const cfg = await f.host.callTool("project_get_config", {});
  assert.equal(cfg.ok, true, JSON.stringify(cfg));
});

test("高危操作:scene_remove_node 缺 confirm 被拒,补 confirm 后成功", async (t) => {
  const f = makeHost(t, false);
  const before = f.chain();

  const denied = await f.host.callTool("scene_remove_node", { path: "res://scenes/main.tscn", nodePath: "Player" });
  assert.equal(codeOf(denied), "CONFIRMATION_REQUIRED");
  assert.equal(f.chain(), before, "拒绝时不得写入");

  const done = await f.host.callTool("scene_remove_node", { path: "res://scenes/main.tscn", nodePath: "Player", confirm: true });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.ok(!f.chain().includes("[node name=\"Player\""), "confirm 后应真实删除");
});

test("高危操作:dryRun 只返回计划,不落盘", async (t) => {
  const f = makeHost(t, false);
  const before = f.chain();
  const r = await f.host.callTool("scene_remove_node", { path: "res://scenes/main.tscn", nodePath: "Player", dryRun: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(f.chain(), before, "dryRun 不得改动文件");
});

test("高危操作:scene_disconnect_signal 同样需要 confirm", async (t) => {
  const f = makeHost(t, false);
  const args = { path: "res://scenes/main.tscn", sourcePath: "Player", signal: "ready", targetPath: ".", method: "_on_ready" };
  assert.equal(codeOf(await f.host.callTool("scene_disconnect_signal", args)), "CONFIRMATION_REQUIRED");
  const ok = await f.host.callTool("scene_disconnect_signal", { ...args, confirm: true });
  assert.notEqual(codeOf(ok), "CONFIRMATION_REQUIRED");
});

test("project_apply_changes: preview 免确认, commit 需确认", async (t) => {
  const f = makeHost(t, false);
  const changes = [{ path: "res://scenes/main.tscn", content: f.chain() }];
  const preview = await f.host.callTool("project_apply_changes", { changes, mode: "preview" });
  assert.notEqual(codeOf(preview), "CONFIRMATION_REQUIRED");
  const commit = await f.host.callTool("project_apply_changes", { changes, mode: "commit" });
  assert.equal(codeOf(commit), "CONFIRMATION_REQUIRED");
});

test("不存在旁路:src 里除 ToolHost 外没有别处调用 handler", () => {
  // 权限闸门只有 ToolHost.callTool 一处;有第二处 .handler( 调用就等于开了后门。
  const root = path.join(import.meta.dirname!, "..", "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".ts")) continue;
      const rel = path.relative(root, p).replace(/\\/g, "/");
      fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (/\.handler\s*\(/.test(line) && rel !== "mcp/server/toolHost.ts") offenders.push(`${rel}:${i + 1}`);
      });
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `these files call a tool handler directly, bypassing the permission gate:\n${offenders.join("\n")}`);
});

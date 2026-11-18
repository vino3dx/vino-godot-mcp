// T07:取消的结构化诊断 —— 与失败、超时严格区分,且不污染既有错误契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import { GodotMcpError, errorCategory, errorRetryable } from "../src/core/errors.js";
import {
  attachCleanup,
  cancelledError,
  TaskCancelledError,
  TaskTimeoutError,
} from "../src/core/concurrency/cancellation.js";
import { createLogger } from "../src/core/logger.js";
import { createPermissionPolicy } from "../src/core/permissions.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import type { ToolDefinition, ToolResult } from "../src/types/index.js";

type ErrEnvelope = { code: string; category: string; retryable: boolean; message: string; details?: Record<string, unknown> };
const errOf = (r: ToolResult): ErrEnvelope => {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as { ok: false; error: ErrEnvelope }).error;
};

function hostWith(defs: ToolDefinition[], logs: string[] = []): ToolHost<unknown> {
  const logger = {
    debug: () => {}, info: () => {}, warn: (m: string) => { logs.push(`warn:${m}`); },
    error: (m: string) => { logs.push(`error:${m}`); },
  };
  return new ToolHost(new ToolRegistry().registerAll(defs), {}, logger, undefined, createPermissionPolicy());
}

const def = (handler: ToolDefinition["handler"]): ToolDefinition => ({
  name: "utility_cancel", domain: "utility", description: "d", annotations: { readOnly: true },
  dependency: "none", runtimeRequired: false, inputSchema: { type: "object", properties: {} }, handler,
});

test("TASK_CANCELLED:category=cancelled,retryable=false", () => {
  assert.equal(errorCategory("TASK_CANCELLED"), "cancelled");
  assert.equal(errorRetryable("TASK_CANCELLED"), false);
  // 超时语义保持不变,取消没有把它"吃掉"。
  assert.equal(errorCategory("TASK_TIMEOUT"), "concurrency");
  assert.equal(errorRetryable("TASK_TIMEOUT"), true);
});

test("ToolHost:取消 → TASK_CANCELLED 信封,且不被当成 INTERNAL 记 error", async () => {
  const logs: string[] = [];
  const host = hostWith([def(async () => { throw cancelledError({ operation: "utility_cancel", stage: "running" }); })], logs);
  const err = errOf(await host.callTool("utility_cancel", {}));
  assert.equal(err.code, "TASK_CANCELLED");
  assert.equal(err.category, "cancelled");
  assert.equal(err.retryable, false);
  assert.equal(err.details?.["operation"], "utility_cancel");
  assert.equal(err.details?.["stage"], "running");
  assert.deepEqual(logs.filter((l) => l.startsWith("error:")), [], "取消不是 bug,不能进 error 日志");
  assert.equal(logs.filter((l) => l.startsWith("warn:")).length, 1, "留一条 warn 便于排查");
});

test("取消 / 超时 / 普通失败三者的 code + category + retryable 互不相同", async () => {
  const host = hostWith([
    def(async () => { throw cancelledError({ operation: "utility_cancel", stage: "running" }); }),
  ]);
  const cancelled = errOf(await host.callTool("utility_cancel", {}));

  const timeout = errOf(await hostWith([def(async () => {
    throw new GodotMcpError("TASK_TIMEOUT", "too slow", { timeoutMs: 10 });
  })]).callTool("utility_cancel", {}));

  const failed = errOf(await hostWith([def(async () => {
    throw new GodotMcpError("GODOT_PROCESS_FAILED", "exit 1", { exitCode: 1 });
  })]).callTool("utility_cancel", {}));

  assert.equal(cancelled.code, "TASK_CANCELLED");
  assert.equal(timeout.code, "TASK_TIMEOUT");
  assert.equal(failed.code, "GODOT_PROCESS_FAILED");
  assert.equal(cancelled.retryable, false);
  assert.equal(timeout.retryable, true);
  assert.equal(failed.retryable, false);
  assert.notEqual(cancelled.category, failed.category);
  // 原有诊断细节没有被取消机制改写
  assert.equal(failed.details?.["exitCode"], 1);
  assert.equal(timeout.details?.["timeoutMs"], 10);
});

test("取消在执行过程中发生:不再返回成功,也不会变成 INTERNAL", async () => {
  const ctrl = new AbortController();
  const host = hostWith([def(async (_a, _c, exec) => {
    ctrl.abort();
    assert.equal(exec?.signal?.aborted, true);
    return { data: "late-success" };
  })]);
  const err = errOf(await host.callTool("utility_cancel", {}, { signal: ctrl.signal }));
  assert.equal(err.code, "TASK_CANCELLED");
});

test("未预期异常仍然是 INTERNAL(取消机制没有放宽 bug 的上报)", async () => {
  const logs: string[] = [];
  const host = hostWith([def(async () => { throw new TypeError("boom"); })], logs);
  const err = errOf(await host.callTool("utility_cancel", {}));
  assert.equal(err.code, "INTERNAL");
  assert.equal(logs.some((l) => l.startsWith("error:")), true);
});

test("attachCleanup:补诊断但不覆盖原始 code / message / 已有字段", () => {
  const err = new TaskCancelledError("Task x was cancelled by the caller", {
    operation: "x", stage: "cleanup", abortSource: "request",
    cleanup: { processExitConfirmed: false },
  });
  attachCleanup(err, { processExitConfirmed: true, residual: ["staging dir left"], error: "EBUSY" });

  assert.equal(err.code, "TASK_CANCELLED", "code 不能被清理结果改写");
  assert.equal(err.message, "Task x was cancelled by the caller", "原始取消原因不能被覆盖");
  const cleanup = err.details?.["cleanup"] as Record<string, unknown>;
  assert.equal(cleanup["processExitConfirmed"], true, "后到的确认信息应当覆盖先前的不确定");
  assert.deepEqual(cleanup["residual"], ["staging dir left"]);
  assert.equal(cleanup["error"], "EBUSY");
});

test("attachCleanup:空的 residual 不能抹掉已有残留,非空则合并去重", () => {
  const err = new TaskCancelledError("Task runtime_export_project was cancelled by the caller", {
    operation: "runtime_export_project", stage: "cleanup", abortSource: "request",
    cleanup: { processExitConfirmed: false, pid: 4242, residual: ["godot process (pid 4242) did not confirm exit"] },
  });

  // 1) 后到的空数组(例如 staging 清干净了)只说明"这次没新增残留",不能删掉先前的记录。
  attachCleanup(err, { processExitConfirmed: false, residual: [] });
  let cleanup = err.details?.["cleanup"] as { residual: string[]; pid?: number };
  assert.deepEqual(cleanup.residual, ["godot process (pid 4242) did not confirm exit"]);
  assert.equal(cleanup.pid, 4242, "其他字段的合并语义不变");

  // 2) 非空 residual 按并集追加,已有项不重复。
  attachCleanup(err, {
    processExitConfirmed: true,
    residual: ["export staging dir left", "godot process (pid 4242) did not confirm exit"],
  });
  cleanup = err.details?.["cleanup"] as { residual: string[] };
  assert.deepEqual(cleanup.residual, [
    "godot process (pid 4242) did not confirm exit",
    "export staging dir left",
  ]);

  // 3) 重复上报同一份诊断不产生重复项(可反复 attach)。
  attachCleanup(err, { processExitConfirmed: true, residual: ["export staging dir left"] });
  cleanup = err.details?.["cleanup"] as { residual: string[] };
  assert.deepEqual(cleanup.residual, [
    "godot process (pid 4242) did not confirm exit",
    "export staging dir left",
  ]);

  // 4) 原始错误语义始终不被清理诊断改写。
  assert.equal(err.code, "TASK_CANCELLED");
  assert.equal(err.message, "Task runtime_export_project was cancelled by the caller");
});

test("attachCleanup 不碰非 GodotMcpError(系统异常保持原样)", () => {
  const plain = new Error("boom");
  attachCleanup(plain, { processExitConfirmed: false });
  assert.equal((plain as unknown as { details?: unknown }).details, undefined);
});

test("TaskTimeoutError 保留 TASK_TIMEOUT 契约并同样可携带 pendingExit", async () => {
  let settle!: () => void;
  const pendingExit = new Promise<void>((r) => { settle = r; });
  const err = new TaskTimeoutError("timed out, exit unconfirmed", { cleanup: { processExitConfirmed: false } }, pendingExit);
  assert.equal(err.code, "TASK_TIMEOUT");
  assert.equal(err.category, "concurrency");
  assert.equal(err.retryable, true);
  assert.equal(err.pendingExit, pendingExit);
  settle();
  await pendingExit;
});

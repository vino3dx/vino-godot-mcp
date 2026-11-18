// T3:结构化错误与诊断上下文。
// 目标不是"错误信息变长",而是让 AI 读完就知道下一步该改参数、改配置、重试还是报 bug。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/core/logger.js";
import { GodotMcpError, errorCategory, errorRetryable } from "../src/core/errors.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { ToolHost, toMcpContent } from "../src/mcp/server/toolHost.js";
import { createPermissionPolicy } from "../src/core/permissions.js";
import { validate } from "../src/core/validation/schema.js";
import type { ErrorCategory, ErrorCode, ToolDefinition, ToolResult } from "../src/types/index.js";

const quiet = createLogger("error", () => {});

const errOf = (r: ToolResult): { code: string; category: string; retryable: boolean; message: string; details?: Record<string, unknown> } => {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as { ok: false; error: { code: string; category: string; retryable: boolean; message: string; details?: Record<string, unknown> } }).error;
};

function hostWith(defs: ToolDefinition[], opts: { readOnly?: boolean } = {}): ToolHost<unknown> {
  return new ToolHost(new ToolRegistry().registerAll(defs), {}, quiet, undefined, createPermissionPolicy({ readOnly: opts.readOnly }));
}

const def = (name: string, handler: ToolDefinition["handler"], annotations: ToolDefinition["annotations"] = { readOnly: true }): ToolDefinition => ({
  name, domain: "utility", description: "d", annotations, dependency: "none", runtimeRequired: false,
  inputSchema: { type: "object", required: ["x"], properties: { x: { type: "number" }, confirm: { type: "boolean" }, dryRun: { type: "boolean" } } },
  handler,
});

test("每个错误码都有分类,分类覆盖 10 类", () => {
  const codes: ErrorCode[] = [
    "INVALID_ARGUMENT", "TOOL_NOT_FOUND", "FILE_NOT_FOUND", "PARSE_ERROR", "LOCK_TIMEOUT", "TASK_TIMEOUT",
    "RUNTIME_REQUIRED", "RUNTIME_FAILED", "INTERNAL", "PROJECT_NOT_FOUND", "RESOURCE_NOT_FOUND",
    "GODOT_NOT_FOUND", "GODOT_PROCESS_FAILED", "VALIDATION_FAILED", "FILE_CHANGED", "PROTECTED_PATH",
    "ALREADY_EXISTS", "BRIDGE_UNAVAILABLE", "BRIDGE_DISCONNECTED", "BRIDGE_TIMEOUT", "BRIDGE_PROTOCOL_ERROR",
    "EDITOR_INSTANCE_MISMATCH", "EDITOR_NO_SCENE_OPEN", "EDITOR_SCENE_ROOT_MISSING", "EDITOR_NODE_NOT_FOUND",
    "EDITOR_OBJECT_INVALID", "EDITOR_RESPONSE_TOO_LARGE", "EDITOR_PROPERTY_UNKNOWN", "EDITOR_PROPERTY_INVALID",
    "EDITOR_NODE_EXISTS", "EDITOR_NODE_TYPE_UNKNOWN", "EDITOR_CANNOT_REMOVE_ROOT", "EDITOR_HISTORY_EMPTY",
    "EDITOR_WRITE_UNAVAILABLE", "EDITOR_SELECTION_UNAVAILABLE", "INVALID_CONFIGURATION", "TOOL_SELECTION_EMPTY",
    "READ_ONLY", "CONFIRMATION_REQUIRED", "TASK_CANCELLED",
  ];
  // T07 起第 10 类:cancelled(调用方主动取消,与 concurrency/engine 都不同)
  const valid: ErrorCategory[] = ["configuration", "permission", "input", "not-found", "concurrency", "engine", "editor", "filesystem", "internal", "cancelled"];
  for (const code of codes) assert.ok(valid.includes(errorCategory(code)), `${code} → ${errorCategory(code)}`);
  // 抽查语义正确的几个
  assert.equal(errorCategory("READ_ONLY"), "permission");
  assert.equal(errorCategory("FILE_CHANGED"), "filesystem");
  assert.equal(errorCategory("EDITOR_NODE_NOT_FOUND"), "editor");
  assert.equal(errorCategory("GODOT_NOT_FOUND"), "engine");
  assert.equal(errorCategory("TASK_CANCELLED"), "cancelled");
});

test("retryable 只对'等一会可能就好了'的错误为真", () => {
  for (const c of ["LOCK_TIMEOUT", "TASK_TIMEOUT", "BRIDGE_TIMEOUT"] as ErrorCode[]) assert.equal(errorRetryable(c), true, c);
  for (const c of ["INVALID_ARGUMENT", "READ_ONLY", "FILE_CHANGED", "PROTECTED_PATH", "EDITOR_NODE_NOT_FOUND", "INTERNAL", "TASK_CANCELLED"] as ErrorCode[]) assert.equal(errorRetryable(c), false, c);
});

test("GodotMcpError 自带 category/retryable,无需调用方手填", () => {
  const e = new GodotMcpError("LOCK_TIMEOUT", "busy", { path: "res://a.tscn", hint: "retry" });
  assert.equal(e.category, "concurrency");
  assert.equal(e.retryable, true);
  assert.equal(e.details?.["path"], "res://a.tscn");
});

test("参数错误:带 $.field 路径 + hint,且 category=input", async () => {
  const h = hostWith([def("utility_a", async () => ({ data: 1 }))]);
  const e = errOf(await h.callTool("utility_a", { x: "not-a-number" }));
  assert.equal(e.code, "INVALID_ARGUMENT");
  assert.equal(e.category, "input");
  assert.equal(e.retryable, false);
  const errors = e.details?.["errors"] as string[];
  assert.ok(errors[0]?.startsWith("$.x"), `first error should point at $.x, got ${errors[0]}`);
  assert.equal(typeof e.details?.["hint"], "string");
});

test("未预期异常:INTERNAL 保留原始类型但不泄漏堆栈", async () => {
  const h = hostWith([def("utility_bug", async () => { throw new TypeError("cannot read x of undefined"); })]);
  const r = await h.callTool("utility_bug", { x: 1 });
  const e = errOf(r);
  assert.equal(e.code, "INTERNAL");
  assert.equal(e.category, "internal");
  assert.equal(e.details?.["cause"], "TypeError");
  assert.equal(e.details?.["operation"], "utility_bug");
  assert.match(String(e.details?.["hint"]), /bug in the MCP server/);
  // 序列化后的内容里不能出现堆栈帧
  const text = JSON.stringify(toMcpContent(r));
  assert.ok(!/\n\s+at\s/.test(text), "stack frames must not be exposed to the client");
  assert.ok(!text.includes("toolHost.js"), "file paths from the stack must not leak");
});

test("只读拦截:category=permission 且带可执行建议", async () => {
  const h = hostWith([def("utility_write", async () => ({ data: 1 }), { readOnly: false })], { readOnly: true });
  const e = errOf(await h.callTool("utility_write", { x: 1 }));
  assert.equal(e.code, "READ_ONLY");
  assert.equal(e.category, "permission");
  assert.equal(e.details?.["operation"], "write");
  assert.match(String(e.details?.["hint"]), /VINO_GODOT_MCP_READ_ONLY/);
});

test("缺确认:expected/actual 明确写出差什么", async () => {
  const h = hostWith([def("utility_danger", async () => ({ data: 1 }), { readOnly: false, destructive: true })]);
  const e = errOf(await h.callTool("utility_danger", { x: 1 }));
  assert.equal(e.code, "CONFIRMATION_REQUIRED");
  assert.deepEqual(e.details?.["expected"], { confirm: true });
  assert.equal(e.details?.["actual"], "missing");
});

test("JSON Schema 校验器拒绝 NaN 与 Infinity", () => {
  const schema = { type: "object" as const, properties: { n: { type: "number" as const } } };
  assert.equal(validate(schema, { n: Number.NaN }).ok, false);
  assert.equal(validate(schema, { n: Number.POSITIVE_INFINITY }).ok, false);
  assert.equal(validate(schema, { n: 1.5 }).ok, true);
});

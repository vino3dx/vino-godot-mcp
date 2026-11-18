// T1:统一权限体系(只读模式 + 高危操作二次确认)。
//
// 设计原则:
//   1. 权限判断只有一处 —— ToolHost 在调用 handler **之前** 调 policy.check()。
//      任何执行路径(sdkServer / dev-cli / 测试)都经过 ToolHost.callTool,不存在旁路。
//   2. 权限元数据来自既有的 ToolAnnotations(readOnly / destructive),不新造一套字段,
//      也不需要在 69 个工具里逐个加标记 —— 那两个字段已经由 tests/toolSafety.test.ts 守着真实性。
//   3. 默认行为不变:未设 VINO_GODOT_MCP_READ_ONLY 时 readOnly=false,写工具照常执行。
//   4. 高危工具(annotations.destructive)要求 confirm=true;但"只看计划不落盘"的调用
//      (dryRun=true 或 mode="preview")不算执行,不需要确认 —— 否则连预览都被拦住。
import { GodotMcpError } from "./errors.js";
import type { ToolAnnotations } from "../types/index.js";

export const READ_ONLY_ENV = "VINO_GODOT_MCP_READ_ONLY";

/** 权限判定只需要这两个字段,ToolDefinition 天然满足该结构。 */
export interface PermissionSubject {
  name: string;
  annotations: ToolAnnotations;
}

export interface PermissionPolicy {
  /** 全局只读:为 true 时一切非 readOnly 工具被拒绝。 */
  readonly readOnly: boolean;
  /** handler 执行前调用;不允许时抛 GodotMcpError。 */
  check(tool: PermissionSubject, args: Readonly<Record<string, unknown>>): void;
  /** 启动日志用的一行摘要。 */
  summary(): string;
}

const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);
const FALSE_WORDS = new Set(["", "0", "false", "no", "off"]);

/** 严格解析:拼错直接启动失败,不静默当成 false。 */
export function parseReadOnly(raw: string | undefined): boolean {
  const text = (raw ?? "").trim().toLowerCase();
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  throw new GodotMcpError("INVALID_CONFIGURATION", `Invalid ${READ_ONLY_ENV} value "${raw}"; expected one of: true/false/1/0/yes/no/on/off`, {
    env: READ_ONLY_ENV,
    value: raw,
    hint: `Unset ${READ_ONLY_ENV}, or set it to "true" or "false".`,
  });
}

/**
 * 该调用是否"只出计划、不产生任何写入"。
 * 与各写工具既有的 dryRun / project_apply_changes 的 mode=preview 语义对齐。
 */
export function isNonExecutingCall(args: Readonly<Record<string, unknown>>): boolean {
  return args["dryRun"] === true || args["mode"] === "preview";
}

export function createPermissionPolicy(options: { readOnly?: boolean } = {}): PermissionPolicy {
  const readOnly = options.readOnly === true;
  const policy: PermissionPolicy = {
    readOnly,
    check(tool, args) {
      // 1) 只读模式:除 readOnly 工具外一律拒绝。放在最前面,写工具连参数都不碰。
      if (readOnly && !tool.annotations.readOnly) {
        throw new GodotMcpError("READ_ONLY", `Tool "${tool.name}" is a write operation and is blocked: ${READ_ONLY_ENV}=true`, {
          tool: tool.name,
          mode: "read-only",
          env: READ_ONLY_ENV,
          operation: tool.annotations.destructive ? "destructive-write" : "write",
          hint: `Restart the server with ${READ_ONLY_ENV}=false (or unset it) to allow writes. Read-only tools still work.`,
        });
      }
      // 2) 高危操作:必须显式 confirm=true;预览类调用不执行,不需要确认。
      if (tool.annotations.destructive === true && !isNonExecutingCall(args) && args["confirm"] !== true) {
        throw new GodotMcpError("CONFIRMATION_REQUIRED", `Tool "${tool.name}" is destructive and requires confirm=true`, {
          tool: tool.name,
          operation: "destructive-write",
          expected: { confirm: true },
          actual: args["confirm"] === undefined ? "missing" : args["confirm"],
          hint: `Re-call with "confirm": true to execute, or pass "dryRun": true to see the plan only.`,
        });
      }
    },
    summary() {
      return `permissions: read-only=${readOnly}${readOnly ? ` (${READ_ONLY_ENV})` : ""} destructive=require-confirm`;
    },
  };
  return policy;
}

/** 环境变量唯一入口:组合根只调这一个函数。 */
export function permissionPolicyFromEnv(env: Readonly<Record<string, string | undefined>> = {}): PermissionPolicy {
  return createPermissionPolicy({ readOnly: parseReadOnly(env[READ_ONLY_ENV]) });
}

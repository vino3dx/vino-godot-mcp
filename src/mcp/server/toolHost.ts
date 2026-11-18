import { GodotMcpError, errorCategory, errorRetryable } from "../../core/errors.js";
import { createPermissionPolicy, type PermissionPolicy } from "../../core/permissions.js";
import { validate } from "../../core/validation/schema.js";
import type { JsonSchema, Logger, ToolAnnotations, ToolDomain, ToolResult } from "../../types/index.js";
import type { ToolRegistry } from "../registry/toolRegistry.js";

export interface ToolListing { name: string; description: string; inputSchema: JsonSchema; annotations: ToolAnnotations; runtimeRequired: boolean }

/**
 * 与具体 MCP SDK 无关的"工具宿主":鉴权 → 校验入参 → 调用 handler → 统一错误。
 * SDK 适配层(sdkServer.ts)与开发 CLI 都只调用它,因此权限检查无法被绕过。
 */
export class ToolHost<Ctx> {
  constructor(
    private readonly registry: ToolRegistry<Ctx>,
    private readonly ctx: Ctx,
    private readonly logger: Logger,
    private readonly enabled?: ReadonlySet<ToolDomain>,
    /** T1:默认策略 = 不做只读限制,但高危操作仍要求 confirm。 */
    private readonly policy: PermissionPolicy = createPermissionPolicy(),
  ) {}

  listTools(): ToolListing[] {
    return this.registry.list(this.enabled).map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: t.annotations, runtimeRequired: t.runtimeRequired,
    }));
  }

  /** 当前生效的权限摘要(启动日志 / MCP instructions 用)。 */
  permissionSummary(): string {
    return this.policy.summary();
  }

  async callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.registry.get(name);
    if (!tool || (this.enabled && this.enabled.size > 0 && !this.enabled.has(tool.domain))) {
      return fail("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
    }
    // 权限先于参数校验:只读模式下写工具直接拒绝,不因为参数不合法而给出别的错误码。
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      this.policy.check(tool, args);
    } catch (e) {
      if (e instanceof GodotMcpError) return fail(e.code, e.message, e.details);
      throw e;
    }
    const v = validate(tool.inputSchema, rawArgs ?? {});
    if (!v.ok) {
      return fail("INVALID_ARGUMENT", `Invalid arguments for ${name}`, {
        errors: v.errors,
        // 第一条错误已经带了 "$.field" 路径,直接指给调用方看。
        hint: v.errors[0] ?? "Check the tool input schema.",
      });
    }
    try {
      const out = await tool.handler(v.value as Record<string, unknown>, this.ctx);
      return {
        ok: true, data: out.data,
        ...(out.message !== undefined ? { message: out.message } : {}),
        // warnings 是非致命提示(如 EDITOR_CONFLICT_WARNING),与错误信封分开;空数组不出现
        ...(out.warnings && out.warnings.length > 0 ? { warnings: out.warnings } : {}),
        // image 是可选图片内容块(如截图),由 toMcpContent 转成独立 image content block
        ...(out.image ? { image: out.image } : {}),
      };
    } catch (e) {
      if (e instanceof GodotMcpError) return fail(e.code, e.message, e.details);
      // 未预期异常:保留类型名与首行信息用于定位,但不把完整堆栈泄给客户端。
      this.logger.error(`Unhandled error in ${name}`, e instanceof Error ? e.stack : String(e));
      return fail("INTERNAL", e instanceof Error ? e.message : String(e), {
        cause: e instanceof Error ? e.name : typeof e,
        operation: name,
        hint: "This is a bug in the MCP server, not in your arguments. Report it with the tool name and arguments.",
      });
    }
  }
}

function fail(code: Extract<ToolResult, { ok: false }>["error"]["code"], message: string, details?: Record<string, unknown>): ToolResult {
  return { ok: false, error: { code, category: errorCategory(code), retryable: errorRetryable(code), message, ...(details ? { details } : {}) } };
}

/** MCP 内容块(text / image)。image 结构遵循 MCP 规范:{ type: "image", data(base64), mimeType }。 */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * ToolResult → MCP 内容块。text 块序列化信封(不含 image 字段,避免 base64 重复);
 * image 作为独立内容块紧随其后。warnings 随信封整体序列化,无需额外处理。
 */
export function toMcpContent(r: ToolResult): { content: McpContentBlock[]; isError?: boolean } {
  if (r.ok) {
    const { image, ...payload } = r;
    const content: McpContentBlock[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
    if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    return { content };
  }
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: true };
}

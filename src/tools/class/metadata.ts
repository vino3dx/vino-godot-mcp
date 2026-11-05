import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

// 这三个工具都会启动一次 `godot --headless --dump-extension-api`(按引擎版本缓存),
// 并把 ~6.5MB 的 extension_api.json 写进 <projectRoot>/.vino-godot-mcp/extension-api/。
// 它们不修改用户的工程内容,但确实启动外部进程并写文件系统,所以 readOnly=false。
export const classGetInfo: ToolDefinition<AppContext> = {
  name: "class_get_info", domain: "class", description: "Query engine ClassDB metadata for a Godot class. This is API metadata from an engine dump, not a live Editor object. May start `godot --dump-extension-api` once per engine version and cache the dump under the project, so it is not read-only.",
  inputSchema: { type: "object", required: ["className"], properties: { className: { type: "string", minLength: 1 }, projectPath: { type: "string", minLength: 1 } } }, annotations: { readOnly: false, idempotent: true }, runtimeRequired: true, dependency: "godot",
  async handler(args, ctx) { return { data: await ctx.godotApi.getClassInfo(args.projectPath as string | undefined, args.className as string) }; },
};

export const classSearch: ToolDefinition<AppContext> = {
  name: "class_search", domain: "class", description: "Search the complete engine ClassDB index by class name.",
  inputSchema: { type: "object", properties: { query: { type: "string", default: "" }, projectPath: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } } }, annotations: { readOnly: false, idempotent: true }, runtimeRequired: true, dependency: "godot",
  async handler(args, ctx) { return { data: await ctx.godotApi.searchClasses(args.projectPath as string | undefined, args.query as string | undefined ?? "", args.limit as number | undefined) }; },
};

export const classValidateMember: ToolDefinition<AppContext> = {
  name: "class_validate_member", domain: "class", description: "Validate a property, method, or signal against engine ClassDB metadata.",
  inputSchema: { type: "object", required: ["className"], properties: { className: { type: "string", minLength: 1 }, property: { type: "string", minLength: 1 }, method: { type: "string", minLength: 1 }, signal: { type: "string", minLength: 1 }, projectPath: { type: "string", minLength: 1 } } }, annotations: { readOnly: false, idempotent: true }, runtimeRequired: true, dependency: "godot",
  async handler(args, ctx) { return { data: await ctx.godotApi.validateMember(args.projectPath as string | undefined, args.className as string, { ...(args.property ? { property: args.property as string } : {}), ...(args.method ? { method: args.method as string } : {}), ...(args.signal ? { signal: args.signal as string } : {}) }) }; },
};

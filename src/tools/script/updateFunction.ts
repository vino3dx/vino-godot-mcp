import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const scriptUpdateFunction: ToolDefinition<AppContext> = {
  name: "script_update_function", domain: "script",
  description: "Replace exactly one top-level GDScript function while preserving all text outside its function block.",
  inputSchema: { type: "object", required: ["path", "name", "replacement"], properties: { path: { type: "string" }, name: { type: "string" }, replacement: { type: "string" }, projectPath: { type: "string" }, dryRun: { type: "boolean" }, expectedHash: { type: "string" } } },
  annotations: { readOnly: false, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(args.projectPath as string | undefined, args.path as string, (text) => {
      const r = ctx.script.updateFunction(text, args.name as string, args.replacement as string);
      summary = { function: { name: r.functionName, startLine: r.startLine, endLine: r.endLine } };
      return r.text;
    }, { dryRun: args.dryRun as boolean | undefined, expectedHash: args.expectedHash as string | undefined });
    return { data: { ...data, ...summary } };
  },
};

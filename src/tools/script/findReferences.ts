import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const scriptFindReferences: ToolDefinition<AppContext> = {
  name: "script_find_references", domain: "script",
  description: "Find static references to a GDScript symbol across project scripts; dynamic calls are not inferred.",
  inputSchema: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" }, path: { type: "string" }, projectPath: { type: "string" } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const files = args.path === undefined ? ctx.file.listTextFiles(args.projectPath as string | undefined) : [ctx.file.read(args.projectPath as string | undefined, args.path as string)];
    return { data: { symbol: args.symbol, filesScanned: files.length, references: ctx.script.findReferences(files.map((f) => ({ path: f.resPath, text: f.text })), args.symbol as string) } };
  },
};

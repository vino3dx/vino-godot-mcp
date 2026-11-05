import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const scriptAnalyze: ToolDefinition<AppContext> = {
  name: "script_analyze", domain: "script",
  description: "Analyze GDScript inheritance, exports and top-level functions, variables and signals without executing the script.",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, projectPath: { type: "string" } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) { const r = ctx.file.read(args.projectPath as string | undefined, args.path as string); return { data: { resPath: r.resPath, hash: r.hash, analysis: ctx.script.analyze(r.text) } }; },
};

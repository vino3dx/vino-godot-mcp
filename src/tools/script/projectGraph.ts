import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const scriptProjectGraph: ToolDefinition<AppContext> = {
  name: "script_project_graph", domain: "script",
  description: "Build a static disk-context GDScript relationship graph: classes, inheritance, resource/node references, bindings, and signal relations. Dynamic relationships are marked unknown.",
  inputSchema: { type: "object", properties: { projectPath: { type: "string", minLength: 1 } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) { return { data: ctx.gdscriptProject.analyze(args.projectPath as string | undefined) }; },
};

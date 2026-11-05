import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
export const projectInputGet: ToolDefinition<AppContext> = {
  name: "project_input_get", domain: "project",
  description: "Read Godot project Input Map actions and decode keyboard, mouse, joypad button and joypad motion events without modifying project.godot. Unknown event types are retained as raw text.",
  inputSchema: { type: "object", properties: { path: { type: "string", default: "res://project.godot" }, action: { type: "string" }, projectPath: { type: "string" } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) { const read = ctx.file.read(args.projectPath as string | undefined, (args.path as string | undefined) ?? "res://project.godot"); return { data: { resPath: read.resPath, hash: read.hash, actions: ctx.inputMap.get(read.text, args.action as string | undefined) } }; },
};

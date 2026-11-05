import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
export const projectInputUpdate: ToolDefinition<AppContext> = {
  name: "project_input_update", domain: "project",
  description: "Add or update one Godot Input Map action/event using structured parameters. Supports preview, expectedHash, duplicate detection and post-write reparse verification; does not reset unspecified actions.",
  inputSchema: { type: "object", required: ["operation", "action"], properties: { path: { type: "string", default: "res://project.godot" }, projectPath: { type: "string" }, operation: { type: "string", enum: ["add_action", "set_deadzone", "add_event", "remove_event", "replace_event"] }, action: { type: "string" }, deadzone: { type: "number", minimum: 0, maximum: 1 }, eventIndex: { type: "integer", minimum: 0 }, event: { type: "object", required: ["type"], properties: { type: { type: "string", enum: ["InputEventKey", "InputEventMouseButton", "InputEventJoypadButton", "InputEventJoypadMotion"] }, device: { type: "integer" }, windowId: { type: "integer" }, keycode: { type: "integer" }, physicalKeycode: { type: "integer" }, keyLabel: { type: "integer" }, unicode: { type: "integer" }, location: { type: "integer" }, buttonIndex: { type: "integer" }, axis: { type: "integer" }, axisValue: { type: "number" }, pressed: { type: "boolean" }, altPressed: { type: "boolean" }, shiftPressed: { type: "boolean" }, ctrlPressed: { type: "boolean" }, metaPressed: { type: "boolean" }, doubleClick: { type: "boolean" } } }, dryRun: { type: "boolean" }, expectedHash: { type: "string" } } },
  annotations: { readOnly: false, idempotent: false }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const p = (args.path as string | undefined) ?? "res://project.godot"; let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(args.projectPath as string | undefined, p, (text) => { const r = ctx.inputMap.update(text, { operation: args.operation as never, action: args.action as string, ...(args.deadzone === undefined ? {} : { deadzone: args.deadzone as number }), ...(args.eventIndex === undefined ? {} : { eventIndex: args.eventIndex as number }), ...(args.event === undefined ? {} : { event: args.event as never }) } as never); summary = { action: r.action }; return r.text; }, { dryRun: args.dryRun as boolean | undefined, expectedHash: args.expectedHash as string | undefined });
    return { data: { ...data, ...summary } };
  },
};

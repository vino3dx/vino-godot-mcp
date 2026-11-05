import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
const ALLOWED = new Set(["position", "size", "offset_left", "offset_top", "offset_right", "offset_bottom", "anchor_left", "anchor_top", "anchor_right", "anchor_bottom", "custom_minimum_size", "pivot_offset", "rotation", "scale", "visible", "mouse_filter", "layout_mode"]);
export const sceneSetUiLayout: ToolDefinition<AppContext> = {
  name: "scene_set_ui_layout", domain: "scene",
  description: "Apply a semantic UI layout patch to a Control node; verify the result with runtime_inspect_ui.",
  inputSchema: { type: "object", required: ["path", "nodePath", "layout"], properties: { path: { type: "string" }, projectPath: { type: "string" }, nodePath: { type: "string" }, layout: { type: "object" }, dryRun: { type: "boolean" }, expectedHash: { type: "string" } } },
  annotations: { readOnly: false, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const layout = args.layout as Record<string, unknown>; const changes: unknown[] = [];
    const data = await ctx.file.editText(args.projectPath as string | undefined, args.path as string, (text) => {
      let current = text;
      for (const [key, value] of Object.entries(layout)) {
        if (!ALLOWED.has(key) || typeof value !== "string") throw new Error(`Unsupported UI layout property: ${key}`);
        const r = ctx.scene.updateNodePropertyResult(current, args.nodePath as string, key, value); current = r.text; changes.push(r.change);
      }
      return current;
    }, { dryRun: args.dryRun as boolean | undefined, expectedHash: args.expectedHash as string | undefined });
    return { data: { ...data, changes } };
  },
};

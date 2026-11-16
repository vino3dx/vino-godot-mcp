import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import { GodotMcpError } from "../../core/errors.js";
import { SCENE_FIRST_POLICY } from "../../services/developmentGuidelines.js";
import type { NodePropertyValidation } from "../../services/godotApiService.js";
const ALLOWED = new Set(["position", "size", "offset_left", "offset_top", "offset_right", "offset_bottom", "anchor_left", "anchor_top", "anchor_right", "anchor_bottom", "custom_minimum_size", "pivot_offset", "rotation", "scale", "visible", "mouse_filter", "layout_mode"]);
export const sceneSetUiLayout: ToolDefinition<AppContext> = {
  name: "scene_set_ui_layout", domain: "scene",
  description: "Apply a semantic UI layout patch to a Control node; verify the result with runtime_inspect_ui (runtime preset only). " + SCENE_FIRST_POLICY,
  inputSchema: { type: "object", required: ["path", "nodePath", "layout"], properties: { path: { type: "string" }, projectPath: { type: "string" }, nodePath: { type: "string" }, layout: { type: "object", additionalProperties: true, description: "Property name -> raw Godot value (strings); keys are validated against the Control layout allowlist." }, dryRun: { type: "boolean" }, expectedHash: { type: "string" } } },
  annotations: { readOnly: false, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const layout = args.layout as Record<string, unknown>;
    const entries = Object.entries(layout);
    for (const [key, value] of entries) {
      if (!ALLOWED.has(key) || typeof value !== "string") {
        throw new GodotMcpError("INVALID_ARGUMENT", `Unsupported UI layout property: ${key}`, { key });
      }
    }
    const projectPath = args.projectPath as string | undefined;
    const nodePath = args.nodePath as string;
    const read = ctx.file.read(projectPath, args.path as string);
    const node = ctx.scene.getNodeType(read.text, nodePath);
    // P1-A:布局属性同样查 ClassDB;CanvasGroup 这类非 Control 节点会得到明确 warning。
    const validation: NodePropertyValidation = node?.type === undefined
      ? {
          status: "unavailable", source: "none", nodeType: node?.type ?? "",
          nodeTypeExists: false, properties: [], warnings: [],
          reason: node === undefined
            ? "node not found in this scene; validation skipped"
            : "node segment has no type= (instance node); ClassDB validation skipped",
        }
      : await ctx.godotApi.validateNodeProperties(
          projectPath,
          node.type,
          entries.map(([name, value]) => ({ name, value: value as string })),
        );

    const changes: unknown[] = [];
    const data = await ctx.file.editText(projectPath, args.path as string, (text) => {
      let current = text;
      for (const [key, value] of entries) {
        const r = ctx.scene.updateNodePropertyResult(current, nodePath, key, value as string);
        current = r.text;
        changes.push(r.change);
      }
      return current;
    }, { dryRun: args.dryRun as boolean | undefined, expectedHash: args.expectedHash as string | undefined });
    return {
      data: { ...data, changes, propertyValidation: validation, validationSource: validation.source },
      ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {}),
    };
  },
};

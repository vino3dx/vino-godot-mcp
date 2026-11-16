import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const resourceUpdateProperty: ToolDefinition<AppContext> = {
  name: "resource_update_property",
  domain: "resource",
  description:
    "Set or add a property in a .tres section (lossless: only the target line changes). " +
    "sectionHeader: 'resource' for the main resource, or a sub_resource id (e.g. 'GDScript_1'). " +
    "Also returns change:{property, before, after, inFile}: the static literal values written in the file text, " +
    "not engine-loaded resource values (this tool never runs Godot; for real layout values use runtime_inspect_ui — runtime preset only). " +
    "before is null and inFile false when the property was not in the section yet (engine defaults are not guessed); " +
    "a literal that cannot be parsed (e.g. Transform2D(...), ExtResource(...), arrays) is reported as {raw} only.",
  inputSchema: {
    type: "object",
    required: ["path", "sectionHeader", "key", "value"],
    properties: {
      path: { type: "string", description: "Resource file path (res://... or project-relative)." },
      sectionHeader: { type: "string", description: "'resource' or a sub_resource id." },
      key: { type: "string", description: "Property name to set or add." },
      value: { type: "string", description: "Raw Godot expression value." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      args["projectPath"] as string | undefined,
      args["path"] as string,
      (text) => {
        const r = ctx.resource.updateResourcePropertyResult(
          text,
          args["sectionHeader"] as string,
          args["key"] as string,
          args["value"] as string,
        );
        summary = { change: r.change };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    return { data: { ...data, ...summary } };
  },
};

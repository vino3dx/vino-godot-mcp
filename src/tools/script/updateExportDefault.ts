import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const scriptUpdateExportDefault: ToolDefinition<AppContext> = {
  name: "script_update_export_default",
  domain: "script",
  description:
    "Set or add the default value of an @export var in a .gd file (lossless: only the target line changes). " +
    "value is a raw GDScript expression (e.g. '300.0', '\"Hello\"', 'Vector2(1, 2)', '[1, 2]'). " +
    "Also returns change:{property, before, after, inFile}: the static literal values written in the file text, " +
    "not runtime script values (this tool never runs Godot; for real layout values use runtime_inspect_ui). " +
    "before is null and inFile false when the @export var had no default yet; " +
    "a literal that cannot be parsed as a Godot literal (e.g. '[1, 2]') is reported as {raw} only.",
  inputSchema: {
    type: "object",
    required: ["path", "name", "value"],
    properties: {
      path: { type: "string", description: "Script file path (res://... or project-relative)." },
      name: { type: "string", description: "Exported variable name to update (e.g. 'speed')." },
      value: { type: "string", description: "Raw GDScript expression value (e.g. '300.0', '\"Hello\"')." },
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
        const r = ctx.script.updateExportDefaultResult(
          text,
          args["name"] as string,
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

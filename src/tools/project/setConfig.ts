import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const projectSetConfig: ToolDefinition<AppContext> = {
  name: "project_set_config",
  domain: "project",
  description:
    "Set or add a project.godot config value (lossless: only the target line changes, or a new section/key is appended). " +
    "Examples: section 'application' key 'config/name'; section 'display' key 'window/size/viewport_width'; section 'application' key 'run/main_scene'. " +
    "value is a raw Godot expression (quote strings, e.g. '\"res://main.tscn\"'). " +
    "Also returns change:{property, before, after, inFile}: the static literal values written in the file text, " +
    "not the ProjectSettings values the engine reads (this tool never runs Godot; for real layout values use runtime_inspect_ui — runtime preset only). " +
    "property is the key name only (the section is in the section argument); before is null and inFile false when the key was not in the file yet; " +
    "a literal that cannot be parsed as a Godot literal (e.g. PackedStringArray(...)) is reported as {raw} only.",
  inputSchema: {
    type: "object",
    required: ["section", "key", "value"],
    properties: {
      path: { type: "string", description: "Config file path. Defaults to res://project.godot.", default: "res://project.godot" },
      section: { type: "string", description: "Section name (e.g. 'application', 'display')." },
      key: { type: "string", description: "Config key (e.g. 'config/name', 'window/size/viewport_width')." },
      value: { type: "string", description: "Raw Godot expression value (e.g. '\"My Game\"', '1280', '\"res://main.tscn\"')." },
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
        const r = ctx.projectConfig.setConfigValueResult(
          text,
          args["section"] as string,
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

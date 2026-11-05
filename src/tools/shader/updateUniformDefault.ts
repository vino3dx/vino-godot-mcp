import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const shaderUpdateUniformDefault: ToolDefinition<AppContext> = {
  name: "shader_update_uniform_default",
  domain: "shader",
  description:
    "Set or add the default value of a uniform in a .gdshader file (lossless: only the target line changes). " +
    "value is a raw shader expression (e.g. 'vec3(1.0, 0.0, 0.0)', '0.5', 'true'). " +
    "Also returns change:{property, before, after, inFile}: the static literal values written in the file text, " +
    "not engine-compiled shader values (this tool never runs Godot; for real layout values use runtime_inspect_ui). " +
    "before is null and inFile false when the uniform had no `= default` yet; " +
    "a literal that cannot be parsed as a Godot literal (e.g. 'vec3(1.0)') is reported as {raw} only.",
  inputSchema: {
    type: "object",
    required: ["path", "name", "value"],
    properties: {
      path: { type: "string", description: "Shader file path (res://... or project-relative)." },
      name: { type: "string", description: "Uniform name to update (e.g. 'albedo', 'roughness')." },
      value: { type: "string", description: "Raw shader default expression (e.g. 'vec3(1.0)', '0.5')." },
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
        const r = ctx.shader.updateUniformDefaultResult(
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

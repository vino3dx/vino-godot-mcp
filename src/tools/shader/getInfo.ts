import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const shaderGetInfo: ToolDefinition<AppContext> = {
  name: "shader_get_info",
  domain: "shader",
  description:
    "Parse a .gdshader file and return its shader_type, render_mode list and uniform declarations (name, type, hint, default). " +
    "Returns the file hash for optimistic-concurrency writes.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Shader file path (res://... or project-relative)." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const read = ctx.file.read(args["projectPath"] as string | undefined, args["path"] as string);
    return { data: { resPath: read.resPath, hash: read.hash, info: ctx.shader.getShaderInfo(read.text) } };
  },
};

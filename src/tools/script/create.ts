import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import { SCENE_FIRST_POLICY } from "../../services/developmentGuidelines.js";

export const scriptCreate: ToolDefinition<AppContext> = {
  name: "script_create",
  domain: "script",
  description:
    "Create a new text file inside the project (typically a .gd script): writes content as-is with LF line endings and creates missing directories. " +
    "The path must stay inside the project (res://... or project-relative; '..' and user:// are rejected). " +
    "overwrite=false (default) refuses to touch an existing file. " +
    "Overwriting an existing file is restricted: " +
    "(1) engine-generated paths — anything under .godot/ plus .import/.uid files — are always refused with PROTECTED_PATH; " +
    "inside the default protected directories res://data/ and res://assets/ only editable text may be replaced " +
    "(.gd .gdshader .gdshaderinc .tres .tscn .cfg .json .md .txt), binary assets stay protected; " +
    "directories added through VINO_GODOT_MCP_PROTECTED_DIRS are hard-protected (no existing file may be replaced); " +
    "(2) full-file replacement only accepts those same text extensions, any other extension (.png, ...) is refused. " +
    "Creating a file that does not exist yet is allowed inside data/assets and strict directories, but never inside .godot/ or as .import/.uid. " +
    "A .tscn may only be created as a minimal [gd_scene format=3] bootstrap (root node only); add the real nodes with the scene tools. " +
    SCENE_FIRST_POLICY,
  inputSchema: {
    type: "object",
    required: ["scriptPath", "content"],
    properties: {
      scriptPath: { type: "string", description: "Destination path (res://scripts/player.gd or project-relative). Must not escape the project." },
      content: { type: "string", description: "Full file content to write (GDScript source)." },
      overwrite: { type: "boolean", description: "Replace an existing file (default false: report an error instead). Engine paths (.godot/, .import, .uid) and user-protected directories always refuse; data/assets allow editable text only — see the tool description." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Only with overwrite=true: current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    return {
      data: await ctx.file.createText(
        args["projectPath"] as string | undefined,
        args["scriptPath"] as string,
        args["content"] as string,
        {
          ...(args["overwrite"] !== undefined ? { overwrite: args["overwrite"] as boolean } : {}),
          ...(args["dryRun"] !== undefined ? { dryRun: args["dryRun"] as boolean } : {}),
          ...(args["expectedHash"] !== undefined ? { expectedHash: args["expectedHash"] as string } : {}),
        },
      ),
    };
  },
};

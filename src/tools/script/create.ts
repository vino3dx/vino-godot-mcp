import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const scriptCreate: ToolDefinition<AppContext> = {
  name: "script_create",
  domain: "script",
  description:
    "Create a new text file inside the project (typically a .gd script): writes content as-is with LF line endings and creates missing directories. " +
    "The path must stay inside the project (res://... or project-relative; '..' and user:// are rejected). " +
    "overwrite=false (default) refuses to touch an existing file. " +
    "Overwriting an existing file is restricted twice: " +
    "(1) protected directories — res://data/ and res://assets/ including every subdirectory (plus anything added through the " +
    "VINO_GODOT_MCP_PROTECTED_DIRS environment variable) can never be overwritten, the call fails with PROTECTED_PATH; " +
    "(2) only text extensions may be replaced: .gd .gdshader .gdshaderinc .tres .tscn .cfg .json .md .txt, any other extension " +
    "(.png, .tres-less binaries, ...) is refused. Creating a file that does not exist yet is still allowed inside protected directories.",
  inputSchema: {
    type: "object",
    required: ["scriptPath", "content"],
    properties: {
      scriptPath: { type: "string", description: "Destination path (res://scripts/player.gd or project-relative). Must not escape the project." },
      content: { type: "string", description: "Full file content to write (GDScript source)." },
      overwrite: { type: "boolean", description: "Replace an existing file (default false: report an error instead). Never allowed inside res://data/ or res://assets/ (PROTECTED_PATH), and only for text extensions — see the tool description." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Only with overwrite=true: current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false },
  runtimeRequired: false,
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

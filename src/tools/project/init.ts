import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import { RENDERER_METHODS } from "../../services/projectInitService.js";

export const projectInit: ToolDefinition<AppContext> = {
  name: "project_init",
  domain: "project",
  description:
    "Create a Godot 4.x project from nothing: writes project.godot (config_version=5 + [application] + [rendering]), " +
    "the standard scenes/ scripts/ assets/ directories, a minimal [gd_scene format=3] main scene and a .gitignore " +
    "(.godot/, .vino-godot-mcp/). This is the only tool that works when the target directory has no project.godot yet; " +
    "every other project/scene/script tool fails with PROJECT_NOT_FOUND there. " +
    "projectPath must be an ABSOLUTE path — this tool never falls back to the MCP process cwd. The directory is created if missing. " +
    "overwrite=false (default) refuses an existing project.godot with ALREADY_EXISTS before writing anything; " +
    "overwrite=true only regenerates project.godot. An existing .gitignore and an existing main scene are never modified " +
    "(both are create-only here, so real content is never replaced by the empty skeleton). " +
    "dryRun=true returns the exact directories and file contents that would be created, writing nothing. " +
    "Generated output targets any Godot 4.x: config/features is intentionally omitted (no engine version is known to a dependency-free tool; " +
    "Godot appends it on first save). After a successful init the usual cold-start chain works: " +
    "project_get_config → script_create → scene_add_node.",
  inputSchema: {
    type: "object",
    required: ["projectPath", "projectName"],
    properties: {
      projectPath: {
        type: "string",
        minLength: 1,
        description: "Absolute path of the project root to create (must not rely on the MCP process cwd).",
      },
      projectName: {
        type: "string",
        minLength: 1,
        description: "Project name, written to [application] config/name (no quotes, backslashes or line breaks).",
      },
      mainScene: {
        type: "string",
        default: "res://main.tscn",
        description: "Main scene path written to [application] run/main_scene. Defaults to res://main.tscn; must stay inside the project.",
      },
      createMainScene: {
        type: "boolean",
        default: true,
        description: "Also create the minimal [gd_scene format=3] skeleton at mainScene (default true; requires a .tscn path).",
      },
      createDefaultDirs: {
        type: "boolean",
        default: true,
        description: "Create the standard scenes/, scripts/, assets/ directories (default true).",
      },
      renderer: {
        type: "string",
        enum: [...RENDERER_METHODS],
        default: "forward_plus",
        description: "Written to [rendering] renderer/rendering_method. Defaults to forward_plus.",
      },
      overwrite: {
        type: "boolean",
        default: false,
        description: "Regenerate project.godot when one already exists (default false: fail with ALREADY_EXISTS instead).",
      },
      dryRun: {
        type: "boolean",
        default: false,
        description: "Preview the directories and file contents without writing anything.",
      },
    },
  },
  annotations: { readOnly: false },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const result = await ctx.projectInit.init({
      projectPath: args["projectPath"] as string,
      projectName: args["projectName"] as string,
      ...(args["mainScene"] !== undefined ? { mainScene: args["mainScene"] as string } : {}),
      ...(args["createMainScene"] !== undefined ? { createMainScene: args["createMainScene"] as boolean } : {}),
      ...(args["createDefaultDirs"] !== undefined ? { createDefaultDirs: args["createDefaultDirs"] as boolean } : {}),
      ...(args["renderer"] !== undefined ? { renderer: args["renderer"] as (typeof RENDERER_METHODS)[number] } : {}),
      ...(args["overwrite"] !== undefined ? { overwrite: args["overwrite"] as boolean } : {}),
      ...(args["dryRun"] !== undefined ? { dryRun: args["dryRun"] as boolean } : {}),
    });
    const written = result.files.filter((f) => f.status === "created" || f.status === "updated");
    const skipped = result.files.filter((f) => f.status === "skipped");
    return {
      data: result,
      message: result.dryRun
        ? `Dry run: would create ${result.dirs.filter((d) => d.status === "planned").length} directory(ies) and `
          + `${result.files.filter((f) => f.status === "planned").length} file(s) under ${result.projectRoot}; nothing was written.`
        : `Initialised Godot project "${result.projectName}" at ${result.projectRoot} `
          + `(${written.length} file(s) written${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}).`,
    };
  },
};

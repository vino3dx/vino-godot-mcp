import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const runtimeExportProject: ToolDefinition<AppContext> = {
  name: "runtime_export_project",
  domain: "runtime",
  description:
    "Launch the Godot CLI to export/build the project with a named export preset (--export-release / --export-debug) and return its separated stdout/stderr and exit code. " +
    "The process is killed if it does not exit within timeoutMs. Fails with GODOT_NOT_FOUND / GODOT_PROCESS_FAILED / TASK_TIMEOUT.",
  inputSchema: {
    type: "object",
    required: ["preset", "outputPath"],
    properties: {
      projectPath: { type: "string", description: "Project root override. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
      preset: { type: "string", minLength: 1, description: "Export preset name defined in export_presets.cfg." },
      mode: { type: "string", enum: ["release", "debug"], description: "Export mode. Defaults to 'release'.", default: "release" },
      outputPath: { type: "string", minLength: 1, description: "Output file path (required). Must include the filename for the binary (e.g. 'builds/game.exe')." },
      headless: { type: "boolean", description: "Run headless. Defaults to true.", default: true },
      timeoutMs: { type: "integer", description: "Kill the process if it does not exit within this many milliseconds. Defaults to 30000.", minimum: 1, default: 30000 },
      waitTimeoutMs: { type: "integer", description: "Maximum ms to wait for this project's run slot (another run may be in progress).", minimum: 1 },
      args: { type: "array", items: { type: "string" }, description: "Extra Godot CLI flags passed verbatim before the export flag (no shell, no injection)." },
    },
  },
  annotations: { readOnly: false, idempotent: true },
  runtimeRequired: true,
  dependency: "godot",
  async handler(args, ctx) {
    return {
      data: await ctx.runtime.exportProject({
        projectPath: args["projectPath"] as string | undefined,
        preset: args["preset"] as string,
        mode: args["mode"] as "release" | "debug" | undefined,
        outputPath: args["outputPath"] as string,
        headless: args["headless"] as boolean | undefined,
        timeoutMs: args["timeoutMs"] as number | undefined,
        waitTimeoutMs: args["waitTimeoutMs"] as number | undefined,
        extraArgs: args["args"] as string[] | undefined,
        tool: "runtime_export_project",
      }),
    };
  },
};

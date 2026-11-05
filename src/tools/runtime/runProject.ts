import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const runtimeRunProject: ToolDefinition<AppContext> = {
  name: "runtime_run_project",
  domain: "runtime",
  description:
    "Launch the Godot CLI to run the project (or a specific scene) and return its separated stdout/stderr and exit code. " +
    "Headless and --quit are on by default, so this works as a smoke test that terminates and returns logs. " +
    "The process is killed if it does not exit within timeoutMs. Fails with GODOT_NOT_FOUND / GODOT_PROCESS_FAILED / TASK_TIMEOUT.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
      scene: { type: "string", description: "Scene to run instead of the project main scene (res://... or project-relative path)." },
      headless: { type: "boolean", description: "Run without a window. Defaults to true.", default: true },
      quit: { type: "boolean", description: "Quit after the first iteration (smoke test). Defaults to true.", default: true },
      timeoutMs: { type: "integer", description: "Kill the process if it does not exit within this many milliseconds. Defaults to 30000.", minimum: 1, default: 30000 },
      waitTimeoutMs: { type: "integer", description: "Maximum ms to wait for this project's run slot (another run may be in progress).", minimum: 1 },
      args: { type: "array", items: { type: "string" }, description: "Extra Godot CLI flags passed verbatim before the scene (no shell, no injection)." },
    },
  },
  annotations: { readOnly: false, idempotent: false },
  runtimeRequired: true,
  dependency: "godot",
  async handler(args, ctx) {
    return {
      data: await ctx.runtime.runProject({
        projectPath: args["projectPath"] as string | undefined,
        scene: args["scene"] as string | undefined,
        headless: args["headless"] as boolean | undefined,
        quit: args["quit"] as boolean | undefined,
        timeoutMs: args["timeoutMs"] as number | undefined,
        waitTimeoutMs: args["waitTimeoutMs"] as number | undefined,
        extraArgs: args["args"] as string[] | undefined,
        tool: "runtime_run_project",
      }),
    };
  },
};

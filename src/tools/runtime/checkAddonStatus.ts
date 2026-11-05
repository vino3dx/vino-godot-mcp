import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const runtimeCheckAddonStatus: ToolDefinition<AppContext> = {
  name: "runtime_check_addon_status",
  domain: "runtime",
  description:
    "Diagnose GDExtension / editor-plugin registration status instead of guessing from log output. Two parts. " +
    "(1) Static scan, no engine needed: every .gdextension in the project (entry_symbol, compatibility_minimum and each " +
    "[libraries] entry with whether the file exists and whether its platform matches this host), .godot/extension_list.cfg, and " +
    "every plugin enabled in project.godot [editor_plugins] (plugin.cfg name/script plus whether those files exist). " +
    "(2) One headless Godot run (temporary GDScript via --script, never written into the project) reporting " +
    "GDExtensionManager.get_loaded_extensions(), ClassDB registration for the requested classes, and the engine version. " +
    "Both parts merge into a 'diagnosis' string list: 'extension_list_missing' (a .gdextension exists but .godot/extension_list.cfg " +
    "does not - open the project once in the editor, or run `godot --headless --import`), 'extension_not_listed:<path>', " +
    "'extension_not_loaded:<path>', 'library_missing:<path>', 'class_missing:<Name>', 'plugin_files_missing:<path>'. " +
    "If Godot cannot be located, times out or fails, the static part is STILL returned with engine={ok:false,error:{code,message}} " +
    "while extensions[].loaded and classes stay null (unknown - NOT false / \"not registered\"); engine.stderr carries the run's " +
    "stderr summary when it has content (e.g. a failed extension load). plugins[] only reports 'enabled + files present' and never " +
    "claims a plugin is loaded. NOTE: this does run the engine, which initializes the project and DOES execute autoloads, hence " +
    "readOnly=false. Fails with INVALID_ARGUMENT (more than 50 classes) / PROJECT_NOT_FOUND.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
      classes: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "Class names to look up in ClassDB, e.g. [\"FFmpegVideoStream\"]. At most 50. Names that are not registered come back with exists=false and produce class_missing:<Name>.",
      },
      timeoutMs: { type: "integer", minimum: 1, default: 30000, description: "Kill the Godot process if it does not exit within this many milliseconds. Defaults to 30000." },
      waitTimeoutMs: { type: "integer", minimum: 1, description: "Maximum ms to wait for this project's run slot (another run may be in progress)." },
    },
  },
  annotations: { readOnly: false, idempotent: true },
  // 引擎不可用时静态部分仍要返回,所以不设执行门槛(与 runtime_get_version 同)。
  runtimeRequired: false,
  dependency: "godot",
  async handler(args, ctx) {
    return {
      data: await ctx.runtime.checkAddonStatus({
        projectPath: args["projectPath"] as string | undefined,
        classes: args["classes"] as string[] | undefined,
        timeoutMs: args["timeoutMs"] as number | undefined,
        waitTimeoutMs: args["waitTimeoutMs"] as number | undefined,
        tool: "runtime_check_addon_status",
      }),
    };
  },
};

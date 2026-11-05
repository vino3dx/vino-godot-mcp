import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneConnectSignal: ToolDefinition<AppContext> = {
  name: "scene_connect_signal",
  domain: "scene",
  description:
    "Connect a signal in a .tscn scene by writing a persisted [connection] section (lossless; the section is appended after the existing nodes/connections). " +
    "Both nodes must exist in the same scene. An identical signal/from/to/method connection is reported as a duplicate error. " +
    "flags is a bit mask (CONNECT_DEFERRED=1, CONNECT_PERSIST=2, CONNECT_ONE_SHOT=4). CONNECT_PERSIST is implied for connections stored in a .tscn, so only the other bits (1|4|8|...) make a flags= field appear (verified against Godot 4.6.3).",
  inputSchema: {
    type: "object",
    required: ["path", "sourcePath", "signal", "targetPath", "method"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      sourcePath: { type: "string", description: "Node that emits the signal ('.' = scene root)." },
      signal: { type: "string", description: "Signal name (Godot identifier, e.g. 'ready', 'pressed')." },
      targetPath: { type: "string", description: "Node that receives the call ('.' = scene root)." },
      method: { type: "string", description: "Method name on the target node (Godot identifier)." },
      flags: { type: "integer", minimum: 0, description: "Connection flag bit mask: CONNECT_DEFERRED=1, CONNECT_PERSIST=2, CONNECT_ONE_SHOT=4. CONNECT_PERSIST is implied in a .tscn, so 1 is written as flags=3 and 0 writes no flags= field." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      args["projectPath"] as string | undefined,
      args["path"] as string,
      (text) => {
        const r = ctx.scene.connectSignal(text, {
          sourcePath: args["sourcePath"] as string,
          signal: args["signal"] as string,
          targetPath: args["targetPath"] as string,
          method: args["method"] as string,
          ...(args["flags"] !== undefined ? { flags: args["flags"] as number } : {}),
        });
        summary = { status: "connected", flags: r.flags };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    return { data: { ...data, ...summary } };
  },
};

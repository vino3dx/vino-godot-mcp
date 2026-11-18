import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneDisconnectSignal: ToolDefinition<AppContext> = {
  name: "scene_disconnect_signal",
  domain: "scene",
  description:
    "Remove a persisted signal connection from a .tscn scene (deletes the matching [connection] section; lossless). " +
    "The connection is matched on signal + from + to + method. A connection that does not exist is reported with status 'not_found' and no write (not an error).",
  inputSchema: {
    type: "object",
    required: ["path", "sourcePath", "signal", "targetPath", "method"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      sourcePath: { type: "string", description: "Node that emits the signal ('.' = scene root)." },
      signal: { type: "string", description: "Signal name (Godot identifier)." },
      targetPath: { type: "string", description: "Node that receives the call ('.' = scene root)." },
      method: { type: "string", description: "Method name on the target node (Godot identifier)." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
      confirm: { type: "boolean", description: "Destructive: must be true to delete the connection, otherwise CONFIRMATION_REQUIRED. Use dryRun:true to preview." },
    },
  },
  annotations: { readOnly: false, destructive: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      args["projectPath"] as string | undefined,
      args["path"] as string,
      (text) => {
        const r = ctx.scene.disconnectSignal(text, {
          sourcePath: args["sourcePath"] as string,
          signal: args["signal"] as string,
          targetPath: args["targetPath"] as string,
          method: args["method"] as string,
        });
        summary = { status: r.removed ? "disconnected" : "not_found" };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    const message = summary["status"] === "not_found"
      ? `not_found: no [connection] section matches ${args["sourcePath"] as string}.${args["signal"] as string} -> ${args["targetPath"] as string}.${args["method"] as string}; nothing was changed.`
      : undefined;
    return { data: { ...data, ...summary }, ...(message !== undefined ? { message } : {}) };
  },
};

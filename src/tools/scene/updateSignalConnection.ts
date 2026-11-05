import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
export const sceneUpdateSignalConnection: ToolDefinition<AppContext> = {
  name: "scene_update_signal_connection", domain: "scene",
  description: "Update exactly one serialized [connection] entry without deleting/recreating the scene connection. The old source/signal/target/method identify the target; new fields are optional, flags are preserved unless explicitly changed.",
  inputSchema: { type: "object", required: ["path", "sourcePath", "signal", "targetPath", "method"], properties: { path: { type: "string" }, projectPath: { type: "string" }, sourcePath: { type: "string" }, signal: { type: "string" }, targetPath: { type: "string" }, method: { type: "string" }, newSourcePath: { type: "string" }, newSignal: { type: "string" }, newTargetPath: { type: "string" }, newMethod: { type: "string" }, flags: { type: "integer", minimum: 0 }, dryRun: { type: "boolean" }, expectedHash: { type: "string" } } },
  annotations: { readOnly: false, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(args.projectPath as string | undefined, args.path as string, (text) => {
      const r = ctx.scene.updateSignalConnection(text, { sourcePath: args.sourcePath as string, signal: args.signal as string, targetPath: args.targetPath as string, method: args.method as string, ...(args.newSourcePath === undefined ? {} : { newSourcePath: args.newSourcePath as string }), ...(args.newSignal === undefined ? {} : { newSignal: args.newSignal as string }), ...(args.newTargetPath === undefined ? {} : { newTargetPath: args.newTargetPath as string }), ...(args.newMethod === undefined ? {} : { newMethod: args.newMethod as string }), ...(args.flags === undefined ? {} : { flags: args.flags as number }) });
      summary = { updated: r.updated, connection: r.connection };
      return r.text;
    }, { dryRun: args.dryRun as boolean | undefined, expectedHash: args.expectedHash as string | undefined });
    return { data: { ...data, ...summary } };
  },
};

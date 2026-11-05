import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import { GodotMcpError } from "../../core/errors.js";

const sessionId = { type: "string" as const, minLength: 1 };

export const runtimeStartSession: ToolDefinition<AppContext> = {
  name: "runtime_start_session", domain: "runtime",
  description: "Start a persistent Godot runtime session without waiting for it to exit.",
  inputSchema: { type: "object", properties: {
    projectPath: { type: "string", minLength: 1 }, scenePath: { type: "string", minLength: 1 },
    headless: { type: "boolean", default: true }, maxLifetimeMs: { type: "integer", minimum: 1 },
    stopTimeoutMs: { type: "integer", minimum: 0 }, logMaxBytesPerStream: { type: "integer", minimum: 0 },
  }, required: ["projectPath"] }, annotations: { readOnly: false, idempotent: false }, runtimeRequired: true, dependency: "godot",
  async handler(args, ctx) {
    const projectRoot = ctx.project.resolve(args.projectPath as string);
    const executable = ctx.godot.locate().path;
    try {
      return { data: await ctx.runtimeSessions.start({ projectRoot, executable, scene: args.scenePath as string | undefined,
        args: ["--path", projectRoot, ...((args.headless as boolean) ? ["--headless"] : []), ...(args.scenePath ? ["--scene", args.scenePath as string] : [])],
        maxLifetimeMs: args.maxLifetimeMs as number | undefined, stopTimeoutMs: args.stopTimeoutMs as number | undefined,
        logMaxBytesPerStream: args.logMaxBytesPerStream as number | undefined }) };
    } catch (error) {
      if (error instanceof GodotMcpError) throw error;
      throw new GodotMcpError("GODOT_PROCESS_FAILED", error instanceof Error ? error.message : String(error));
    }
  },
};

export const runtimeGetSession: ToolDefinition<AppContext> = {
  name: "runtime_get_session", domain: "runtime", description: "Get the current state and metadata of a persistent Godot session.",
  inputSchema: { type: "object", properties: { sessionId }, required: ["sessionId"] }, annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "godot",
  async handler(args, ctx) { return { data: ctx.runtimeSessions.get(args.sessionId as string) }; },
};

export const runtimeReadSessionLogs: ToolDefinition<AppContext> = {
  name: "runtime_read_session_logs", domain: "runtime", description: "Read persistent session stdout and stderr with independent cursors.",
  inputSchema: { type: "object", properties: { sessionId, stdoutCursor: { type: "integer", minimum: 0 }, stderrCursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 0 }, stream: { type: "string", enum: ["stdout", "stderr", "both"] } }, required: ["sessionId"] }, annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "godot",
  async handler(args, ctx) { return { data: ctx.runtimeSessions.readLogs(args.sessionId as string, (args.stream as "stdout" | "stderr" | "both" | undefined) ?? "both", { stdout: args.stdoutCursor as number | undefined, stderr: args.stderrCursor as number | undefined }, args.limit as number | undefined) }; },
};

export const runtimeStopSession: ToolDefinition<AppContext> = {
  name: "runtime_stop_session", domain: "runtime", description: "Request a persistent Godot session to stop and report confirmed exit separately.",
  inputSchema: { type: "object", properties: { sessionId, timeoutMs: { type: "integer", minimum: 0, default: 1000 } }, required: ["sessionId"] }, annotations: { readOnly: false, destructive: true, idempotent: true }, runtimeRequired: true, dependency: "godot",
  async handler(args, ctx) { return { data: await ctx.runtimeSessions.stop(args.sessionId as string, args.timeoutMs as number) }; },
};

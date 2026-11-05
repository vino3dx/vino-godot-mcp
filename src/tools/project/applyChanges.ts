import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
export const projectApplyChanges: ToolDefinition<AppContext> = {
  name: "project_apply_changes", domain: "project",
  description: "Preview or commit a batch of existing project-file changes. Preview performs all path/hash/content checks without writing; commit rechecks while holding all file locks and attempts recovery if a later write fails. This is not filesystem-level atomicity.",
  inputSchema: { type: "object", required: ["changes", "mode"], properties: { projectPath: { type: "string" }, mode: { type: "string", enum: ["preview", "commit"] }, changes: { type: "array", items: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" }, expectedHash: { type: "string" } } } } } },
  annotations: { readOnly: false, destructive: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    return { data: await ctx.batchFile.apply(args.projectPath as string | undefined, args.changes as Array<{ path: string; content: string; expectedHash?: string }>, args.mode as "preview" | "commit", "project_apply_changes") };
  },
};

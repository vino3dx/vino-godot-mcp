import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const projectCheckChanges: ToolDefinition<AppContext> = {
  name: "project_check_changes",
  domain: "project",
  description:
    "Batch-compare current file hashes with the expected sha256 values recorded earlier (for example from scene_get_tree). " +
    "Read-only: it never writes, locks files, or starts a watcher. Returns {checkedAt,total,unchanged[],modified[],missing[],unreadable[],results[]} " +
    "where results preserve the input order and carry status/hash per path. A missing or unreadable file is reported per entry and does not abort the batch. " +
    "Use this in long tasks to detect edits or deletions the agent did not make. Hash semantics match expectedHash in the write tools: sha256 hex.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      projectPath: { type: "string", description: "Project root override." },
      files: {
        type: "array",
        description: "Explicit list of {path, expectedHash}; only these files are checked.",
        items: {
          type: "object",
          required: ["path", "expectedHash"],
          properties: {
            path: { type: "string", minLength: 1, description: "File path (res://... or project-relative)." },
            expectedHash: { type: "string", minLength: 1, description: "Expected sha256 hex." },
          },
        },
      },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    return {
      data: ctx.changes.check(
        args["projectPath"] as string | undefined,
        args["files"] as Array<{ path: string; expectedHash: string }>,
      ),
    };
  },
};

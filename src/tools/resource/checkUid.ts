import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const resourceCheckUid: ToolDefinition<AppContext> = {
  name: "resource_check_uid",
  domain: "resource",
  description:
    "Read-only check that [ext_resource] uid= and path= in .tscn/.tres files point at the same resource. " +
    "Scans one file, one directory, or the whole project (path is optional). Reports, per reference: " +
    "ok, uid_missing (only path=), path_missing (path= does not exist), uid_unresolved (uid not found in the text index), " +
    "uid_mismatch (uid resolves to another file) and unknown (malformed/ambiguous, cannot confirm). " +
    "UID resolution uses *.uid sidecars, .import [remap] uid=, and .tscn/.tres header uid=; " +
    ".godot/uid_cache.bin is binary and is NOT read, so a UID that exists only there is reported uid_unresolved, never guessed. " +
    "This tool never writes files and never fixes UIDs (resource_fix_uid is not part of this version).",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override." },
      path: { type: "string", minLength: 1, description: "File or directory to scan (res://... or project-relative). Defaults to the whole project." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    return {
      data: ctx.uids.check(
        args["projectPath"] as string | undefined,
        args["path"] as string | undefined,
      ),
    };
  },
};

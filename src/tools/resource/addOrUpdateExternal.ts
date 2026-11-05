import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import type { ExternalResourceInput } from "../../services/resourceService.js";

export const resourceAddOrUpdateExternal: ToolDefinition<AppContext> = {
  name: "resource_add_or_update_external",
  domain: "resource",
  description:
    "Add or update an ext_resource reference in a .tres/.tscn file. Matches by id; reuses an entry with the same path+type; otherwise appends a new ext_resource section.",
  inputSchema: {
    type: "object",
    required: ["path", "resource"],
    properties: {
      path: { type: "string", description: "Resource file path (res://... or project-relative)." },
      resource: {
        type: "object",
        description: "The external resource reference.",
        required: ["id", "type", "path"],
        properties: {
          id: { type: "string", description: "Reference id used in ExtResource(...)." },
          type: { type: "string", description: "Resource type (e.g. 'Script', 'Texture2D')." },
          path: { type: "string", description: "res:// path to the referenced resource." },
          uid: { type: "string", description: "Optional UID (uid://...)." },
        },
      },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const res = args["resource"] as Record<string, unknown>;
    const input: ExternalResourceInput = {
      id: res["id"] as string,
      type: res["type"] as string,
      path: res["path"] as string,
      ...(res["uid"] !== undefined ? { uid: res["uid"] as string } : {}),
    };
    return {
      data: await ctx.file.editText(
        args["projectPath"] as string | undefined,
        args["path"] as string,
        (text) => ctx.resource.addOrUpdateExternalResource(text, input),
        { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
      ),
    };
  },
};

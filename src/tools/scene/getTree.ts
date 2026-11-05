import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneGetTree: ToolDefinition<AppContext> = {
  name: "scene_get_tree",
  domain: "scene",
  description:
    "Parse a .tscn scene file and return its structured node tree (name, type, path, parent, attached script, groups, properties). " +
    "Sub-scene instances are reported as isInstance/instanceScene/overrides and never expanded. " +
    "Also returns every [connection] with source/signal/target/method and flags as { raw (verbatim file value, null when " +
    "the field is absent), semantic (named bits: DEFERRED=1/PERSIST=2/ONE_SHOT=4/REFERENCE_COUNTED=8/APPEND_SOURCE_OBJECT=16), " +
    "otherBits (remaining set bits, e.g. the engine-implicit INHERITED=32) }. " +
    "Returns the file hash so a later write can pass expectedHash for optimistic concurrency.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      projectPath: { type: "string", description: "Project root override. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const read = ctx.file.read(args["projectPath"] as string | undefined, args["path"] as string);
    return { data: { resPath: read.resPath, hash: read.hash, tree: ctx.scene.getSceneTree(read.text) } };
  },
};

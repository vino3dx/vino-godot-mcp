import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
export const sceneGetConnections: ToolDefinition<AppContext> = {
  name: "scene_get_connections", domain: "scene",
  description: "Read serialized [connection] entries from a .tscn scene. Filters are applied to normalized scene-root-relative paths; results are static file data, not runtime signal state.",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, projectPath: { type: "string" }, sourcePath: { type: "string" }, targetPath: { type: "string" }, signal: { type: "string" }, method: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 100 } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const read = ctx.file.read(args.projectPath as string | undefined, args.path as string);
    const tree = ctx.scene.getSceneTree(read.text);
    const normalize = (v: string | undefined) => v === undefined ? undefined : v.replace(/^\/root\/?/, "").replace(/^\.?\//, "") || ".";
    const source = normalize(args.sourcePath as string | undefined), target = normalize(args.targetPath as string | undefined);
    const all = tree.connections.filter((c) => (source === undefined || c.source === source) && (target === undefined || c.target === target) && (args.signal === undefined || c.signal === args.signal) && (args.method === undefined || c.method === args.method));
    const max = (args.maxResults as number | undefined) ?? 100;
    return { data: { resPath: read.resPath, hash: read.hash, connections: all.slice(0, max), total: all.length, truncated: all.length > max } };
  },
};

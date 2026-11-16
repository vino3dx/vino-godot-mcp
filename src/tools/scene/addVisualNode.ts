import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import { SCENE_FIRST_POLICY } from "../../services/developmentGuidelines.js";

export const sceneAddVisualNode: ToolDefinition<AppContext> = {
  name: "scene_add_visual_node", domain: "scene",
  description: "Create a TextureRect, Sprite2D or NinePatchRect and bind a project texture through ExtResource. Prefer this over writing a path or load() expression into a scene. " + SCENE_FIRST_POLICY,
  inputSchema: { type: "object", required: ["path", "parentPath", "nodeName", "texture"], properties: {
    path: { type: "string" }, projectPath: { type: "string" }, parentPath: { type: "string" }, nodeName: { type: "string" }, texture: { type: "string" },
    nodeType: { type: "string", enum: ["TextureRect", "Sprite2D", "NinePatchRect"], default: "TextureRect" },
    properties: { type: "array", items: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
    autoRename: { type: "boolean" }, dryRun: { type: "boolean" }, expectedHash: { type: "string" },
  } },
  annotations: { readOnly: false, idempotent: false }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const type = (args.nodeType as string | undefined) ?? "TextureRect";
    const texture = args.texture as string;
    const id = `texture_${texture.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_")}`;
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(args.projectPath as string | undefined, args.path as string, (text) => {
      const withExt = ctx.resource.addOrUpdateExternalResource(text, { id, type: "Texture2D", path: texture });
      const props = [{ name: "texture", value: `ExtResource("${id}")` }, ...((args.properties as Array<{name:string;value:string}> | undefined) ?? [])];
      const result = ctx.scene.addNode(withExt, { parentPath: args.parentPath as string, nodeType: type, nodeName: args.nodeName as string, properties: props, autoRename: args.autoRename as boolean | undefined });
      summary = { nodePath: result.nodePath, nodeType: type, texture, resourceId: id };
      return result.text;
    }, { dryRun: args.dryRun as boolean | undefined, expectedHash: args.expectedHash as string | undefined });
    return { data: { ...data, ...summary } };
  },
};

import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorGetNode: ToolDefinition<AppContext> = {
  name: "editor_get_node",
  domain: "editor",
  description:
    "EDITOR CONTEXT: describe one node of the scene currently open for editing, live from the Godot Editor Plugin. " +
    "Returns node identity (path, name, type, className, scriptPath, nodePathAbsolute, parentPath, ownerPath, " +
    "uniqueNameInOwner, instanceScenePath/isInstance, childCount, groups, isControl/isContainer, objectId, isValid) plus its " +
    "property table from Node.get_property_list(): name, type, usage, hint, hintString. " +
    "properties=\"values\" (default) also reads each property value through a JSON-safe encoder: primitives and math types are " +
    "returned as structured values, Object/Resource as a reference descriptor only (class, instanceId, nodePath/resourcePath), " +
    "Callable/Signal/RID as text descriptors, nested arrays/dictionaries truncated (64 items, depth 3). " +
    "No property is deep-serialized and one unreadable property never fails the whole call: it is returned with status and a " +
    "note instead. Values come from the in-memory editor scene, so they include unsaved edits and can differ from the .tscn on " +
    "disk. Use properties=\"list\" for name-only metadata, propertyNames to narrow, maxProperties (default/cap 400) to bound the " +
    "response. Errors: BRIDGE_UNAVAILABLE / BRIDGE_DISCONNECTED / BRIDGE_TIMEOUT / EDITOR_INSTANCE_MISMATCH / " +
    "EDITOR_NO_SCENE_OPEN / EDITOR_SCENE_ROOT_MISSING / EDITOR_NODE_NOT_FOUND / EDITOR_OBJECT_INVALID / " +
    "EDITOR_RESPONSE_TOO_LARGE.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      nodePath: { type: "string", description: "Node path relative to the edited scene root (\".\" or empty = scene root, e.g. \"World/Player\")." },
      properties: { type: "string", enum: ["none", "list", "values"], default: "values", description: "\"none\" = identity only, \"list\" = property metadata, \"values\" = metadata + JSON-safe values (default)." },
      propertyNames: { type: "array", items: { type: "string", minLength: 1 }, description: "Only include these property names." },
      maxProperties: { type: "integer", minimum: 1, maximum: 400, default: 400, description: "Maximum properties returned; truncatedProperties=true when exceeded." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.getEditorNode(root, {
      nodePath: args["nodePath"] as string | undefined,
      properties: args["properties"] as "none" | "list" | "values" | undefined,
      propertyNames: args["propertyNames"] as string[] | undefined,
      maxProperties: args["maxProperties"] as number | undefined,
    });
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};

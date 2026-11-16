import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import type { AssetImportStatus } from "../../services/assetService.js";

/** 显式分页时的默认页大小;不传 limit/offset 时保持旧的完整列表行为。 */
const DEFAULT_PAGE_LIMIT = 100;
const IMPORT_STATUSES: readonly AssetImportStatus[] = [
  "imported", "not_imported", "artifact_missing", "invalid_import", "not_applicable", "unknown",
];

export const assetList: ToolDefinition<AppContext> = {
  name: "asset_list", domain: "asset",
  description:
    "List project assets that can be used by Godot scenes, including textures, dimensions, scenes and resources. " +
    "importStatus is verified against disk: 'imported' only when the .import record names dest_files/remap.path artifacts that actually exist and are non-empty; " +
    "'not_imported' (no .import), 'artifact_missing' (record exists, product missing/empty), 'invalid_import' (unparseable or inconsistent record), " +
    "'unknown' (record unreadable), 'not_applicable' (.tscn/.tres load natively and are not imported). " +
    "The legacy boolean 'imported' is true only for status 'imported'. " +
    "Pagination is opt-in: omit limit/offset to get the legacy full list; when either is set the response carries total/returned/offset/limit/nextOffset/hasMore. " +
    "filter is a case-insensitive path substring; extension accepts 'png' or '.png'; importStatus filters by the verified status.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string" },
      kind: { type: "string", enum: ["texture", "font", "scene", "resource"] },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "Page size (max 500). Omit for the legacy full listing." },
      offset: { type: "integer", minimum: 0, default: 0, description: "Skip this many filtered assets. Implies paging." },
      filter: { type: "string", minLength: 1, description: "Case-insensitive substring matched against res:// paths." },
      extension: { type: "string", minLength: 1, description: "Extension filter, e.g. 'png' or '.tscn'." },
      importStatus: { type: "string", enum: IMPORT_STATUSES, description: "Only assets with this verified import status." },
    },
  },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const assets = ctx.assets.list(args.projectPath as string | undefined, {
      ...(args.kind !== undefined ? { kind: args.kind as string } : {}),
      ...(args.filter !== undefined ? { filter: args.filter as string } : {}),
      ...(args.extension !== undefined ? { extension: args.extension as string } : {}),
      ...(args.importStatus !== undefined ? { importStatus: args.importStatus as AssetImportStatus } : {}),
    });
    // 正常状态的 importDetails 只是 status 的重复描述;仅在需要排查时保留细节,降低列表体积。
    const lean = assets.map((asset) => (
      asset.importStatus === "artifact_missing" || asset.importStatus === "invalid_import" || asset.importStatus === "unknown"
        ? asset
        : { ...asset, importDetails: undefined }
    ));
    const total = assets.length;
    const offset = (args.offset as number | undefined) ?? 0;
    const paging = args.limit !== undefined || offset > 0;
    if (!paging) {
      return { data: { assets: lean, total, returned: total, offset: 0, limit: null, nextOffset: null, hasMore: false } };
    }
    const limit = (args.limit as number | undefined) ?? DEFAULT_PAGE_LIMIT;
    const page = lean.slice(offset, offset + limit);
    const nextOffset = offset + page.length < total ? offset + page.length : null;
    return {
      data: {
        assets: page, total, returned: page.length, offset, limit, nextOffset, hasMore: nextOffset !== null,
      },
    };
  },
};

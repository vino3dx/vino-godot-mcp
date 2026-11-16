import fs from "node:fs";
import path from "node:path";
import { ProjectResolver } from "../core/project/projectResolver.js";
import { GodotMcpError } from "../core/errors.js";
import { within } from "../core/filesystem/fileGuard.js";
import { getGodotConfigValue, parseGodotConfigFile, type GodotConfigAST } from "../core/parser/index.js";
import { splitArrayElements, unquote } from "../core/parser/internal.js";

/**
 * 资源导入状态。语义:
 *   imported         .import 记录有效,且 dest_files / remap.path 指向的产物全部存在。
 *   not_imported     没有 .import(该资源从未被 Godot 导入)。
 *   artifact_missing .import 存在且可解析,但至少一个导入产物缺失或为空文件。
 *   invalid_import   .import 无法解析、缺关键字段、路径越界或 source_file 与当前资源不一致。
 *   not_applicable   该类型不经过导入步骤(.tscn / .tres 由引擎直接加载)。
 *   unknown          .import 存在但无法读取(权限/IO),不能确认。
 *
 * `imported` 布尔字段仅为向后兼容保留:**只有 imported 状态才为 true**。
 */
export type AssetImportStatus = "imported" | "not_imported" | "artifact_missing" | "invalid_import" | "not_applicable" | "unknown";

/** 导入判定的依据(便于 Agent 与测试定位问题,不猜引擎状态)。 */
export interface AssetImportDetails {
  status: AssetImportStatus;
  /** `.import` 文件的 res:// 路径(记录存在时)。 */
  importFile?: string;
  /** 已确认存在且非空的产物 res:// 路径。 */
  artifacts?: string[];
  /** 缺失或为空的产物 res:// 路径。 */
  missingArtifacts?: string[];
  /** 机器可读原因码(仅非 imported 状态)。 */
  reason?: string;
  /** 人类可读补充说明;不含推测。 */
  detail?: string;
}

export interface AssetInfo {
  path: string;
  extension: string;
  kind: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  /** 兼容字段:仅当 importStatus === "imported" 时为 true。 */
  imported: boolean;
  importStatus: AssetImportStatus;
  importDetails: AssetImportDetails;
}

/** 需要经过 Godot 导入步骤的资源类型。 */
const IMPORTED_KINDS = new Set(["texture", "font"]);

/** 列表过滤条件;全部可选,不传时保持旧的"返回全部资源"行为。 */
export interface AssetListOptions {
  kind?: string;
  /** 路径子串,大小写不敏感。 */
  filter?: string;
  /** 扩展名,可带或不带前导点(大小写不敏感)。 */
  extension?: string;
  importStatus?: AssetImportStatus;
}

export class AssetService {
  constructor(private readonly resolver: ProjectResolver) {}

  /** 单次遍历 + 过滤(不在分页时重复扫描项目)。 */
  list(projectPath?: string, options: AssetListOptions = {}): AssetInfo[] {
    const root = this.resolver.resolve(projectPath);
    const needle = options.filter?.trim().toLowerCase();
    const requestedExt = options.extension?.trim().toLowerCase();
    const extension = requestedExt === undefined || requestedExt === ""
      ? undefined
      : requestedExt.startsWith(".") ? requestedExt : `.${requestedExt}`;
    const out: AssetInfo[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".godot" || entry.name === ".git") continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        const info = this.info(root, abs);
        if (!info) continue;
        if (options.kind !== undefined && info.kind !== options.kind) continue;
        if (extension !== undefined && info.extension !== extension) continue;
        if (needle !== undefined && needle !== "" && !info.path.toLowerCase().includes(needle)) continue;
        if (options.importStatus !== undefined && info.importStatus !== options.importStatus) continue;
        out.push(info);
      }
    };
    walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  getInfo(projectPath: string | undefined, resPath: string): AssetInfo {
    const root = this.resolver.resolve(projectPath);
    const abs = path.resolve(root, resPath.replace(/^res:\/\//, ""));
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) throw new GodotMcpError("INVALID_ARGUMENT", `资源路径越界: ${resPath}`, { resPath });
    const info = this.info(root, abs);
    if (!info) throw new GodotMcpError("FILE_NOT_FOUND", `资源不存在或类型不支持: ${resPath}`, { resPath });
    return info;
  }

  private info(root: string, abs: string): AssetInfo | undefined {
    const ext = path.extname(abs).toLowerCase();
    const kind = ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".svg" ? "texture"
      : ext === ".ttf" || ext === ".otf" ? "font" : ext === ".tscn" ? "scene" : ext === ".tres" ? "resource" : undefined;
    if (!kind) return undefined;
    const stat = fs.statSync(abs);
    const importDetails = IMPORTED_KINDS.has(kind) ? readImportDetails(root, abs) : { status: "not_applicable" as const };
    const result: AssetInfo = {
      path: toRes(root, abs),
      extension: ext,
      kind,
      sizeBytes: stat.size,
      imported: importDetails.status === "imported",
      importStatus: importDetails.status,
      importDetails,
    };
    if (kind === "texture" && ext === ".png") {
      const dimensions = readPngDimensions(abs);
      if (dimensions) { result.width = dimensions.width; result.height = dimensions.height; }
    }
    return result;
  }
}

// ────────────────────────────── .import 解析 ──────────────────────────────

/**
 * 判定一个资源是否真的可用:
 *   1. `.import` 必须是可解析的 ConfigFile;
 *   2. `[remap] importer` / `type` 必须存在(否则记录无效);
 *   3. `[deps] dest_files` 必须存在且非空 —— 这是导入产物的权威清单;
 *   4. 清单里的每个产物必须落在项目内、存在且非空;
 *   5. `[remap] path` 若存在,也必须是有效产物(部分导入器只写这里);
 *   6. `[deps] source_file` 若存在,必须指向当前资源(否则是过期/错配记录)。
 * 任一步无法确认都返回非 imported,绝不因为“.import 存在”或“资源有宽高”就判成功。
 */
function readImportDetails(root: string, abs: string): AssetImportDetails {
  const importAbs = `${abs}.import`;
  const importFile = toRes(root, importAbs);
  if (!fs.existsSync(importAbs)) return { status: "not_imported", importFile };

  let text: string;
  try {
    text = fs.readFileSync(importAbs, "utf8");
  } catch (e) {
    return { status: "unknown", importFile, reason: "import_unreadable", detail: message(e) };
  }

  let ast: GodotConfigAST;
  try {
    ast = parseGodotConfigFile(text);
  } catch (e) {
    return { status: "invalid_import", importFile, reason: "import_parse_error", detail: message(e) };
  }

  const importer = rawValue(ast, "remap", "importer");
  const type = rawValue(ast, "remap", "type");
  if (importer === undefined || type === undefined) {
    return { status: "invalid_import", importFile, reason: "missing_importer_or_type" };
  }

  const destRaw = rawValue(ast, "deps", "dest_files");
  if (destRaw === undefined) {
    return { status: "invalid_import", importFile, reason: "missing_dest_files" };
  }
  const destFiles = splitArrayElements(destRaw).map(unquote).filter((entry) => entry !== "");
  if (destFiles.length === 0) {
    return { status: "invalid_import", importFile, reason: "empty_dest_files" };
  }

  const artifacts: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const candidate of destFiles) {
    const resolved = resolveResFile(root, candidate);
    if (resolved === undefined) {
      return { status: "invalid_import", importFile, reason: "dest_outside_project", detail: candidate };
    }
    if (seen.has(resolved.resPath)) continue;
    seen.add(resolved.resPath);
    if (isNonEmptyFile(resolved.absPath)) artifacts.push(resolved.resPath);
    else missing.push(resolved.resPath);
  }

  // [remap] path 是部分导入器写下的主产物;与 dest_files 取并集,不重复判定。
  const remapPath = rawValue(ast, "remap", "path");
  if (remapPath !== undefined && remapPath !== "") {
    const resolved = resolveResFile(root, remapPath);
    if (resolved === undefined) {
      return { status: "invalid_import", importFile, reason: "remap_path_outside_project", detail: remapPath };
    }
    if (!seen.has(resolved.resPath)) {
      seen.add(resolved.resPath);
      if (isNonEmptyFile(resolved.absPath)) artifacts.push(resolved.resPath);
      else missing.push(resolved.resPath);
    }
  }

  if (missing.length > 0) {
    return { status: "artifact_missing", importFile, artifacts, missingArtifacts: missing, reason: "artifact_missing" };
  }

  const sourceFile = rawValue(ast, "deps", "source_file");
  if (sourceFile !== undefined && sourceFile !== "") {
    const expected = toRes(root, abs);
    if (!sameResPath(sourceFile, expected)) {
      return {
        status: "invalid_import", importFile, artifacts,
        reason: "source_mismatch", detail: `source_file=${sourceFile}, actual=${expected}`,
      };
    }
  }

  return { status: "imported", importFile, artifacts };
}

/** 读 [section] key 的原文;值统一按字符串处理(裸值也接受)。 */
function rawValue(ast: GodotConfigAST, section: string, key: string): string | undefined {
  const raw = getGodotConfigValue(ast, section, key);
  if (raw === undefined) return undefined;
  return unquote(raw);
}

/** `res://...` → 项目内绝对路径;越界返回 undefined。 */
function resolveResFile(root: string, resPath: string): { absPath: string; resPath: string } | undefined {
  if (!resPath.startsWith("res://")) return undefined;
  const absPath = path.resolve(root, resPath.slice("res://".length).replace(/\//g, path.sep));
  if (!within(root, absPath)) return undefined;
  return { absPath, resPath: toRes(root, absPath) };
}

/** Windows 大小写不敏感;其余平台按原样比较。 */
function sameResPath(a: string, b: string): boolean {
  const left = a.replace(/\\/g, "/");
  const right = b.replace(/\\/g, "/");
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isNonEmptyFile(absPath: string): boolean {
  try {
    const stat = fs.statSync(absPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function toRes(root: string, abs: string): string {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return rel === "" ? "res://" : `res://${rel}`;
}

function readPngDimensions(abs: string): { width: number; height: number } | undefined {
  try {
    const b = fs.readFileSync(abs);
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    // 读不到尺寸不影响导入状态判定;不伪造宽高。
  }
  return undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

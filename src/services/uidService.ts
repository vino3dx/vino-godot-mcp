// P1-B:UID 与 Path 一致性检查(只读,不修复)。
//
// UID 索引只用可验证的文本来源:
//   1. `*.uid` sidecar:内容即 uid(脚本/着色器等);
//   2. `*.import` 的 `[remap] uid=`(导入资源,指向源文件);
//   3. `.tscn` / `.tres` 段头的 `uid="uid://..."`(场景与文本资源自身)。
// `.godot/uid_cache.bin` 是引擎二进制缓存,本版本不解析:索引里找不到的 UID 一律报
// `uid_unresolved`(无法解析),绝不猜它指向哪个文件,也不改动任何资源。
import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import { FileGuard } from "../core/filesystem/fileGuard.js";
import { getGodotConfigValue, parseGodotConfigFile, parseGodotResource } from "../core/parser/index.js";
import type { ProjectResolver } from "../core/project/projectResolver.js";

export type UidStatus = "ok" | "uid_missing" | "path_missing" | "uid_unresolved" | "uid_mismatch" | "unknown";

export interface UidIssue {
  /** 引用所在的 .tscn/.tres(res://)。 */
  file: string;
  /** `[ext_resource]` 的 id。 */
  resourceId: string;
  resourceType?: string;
  uid?: string;
  path?: string;
  status: UidStatus;
  /** UID 索引解析出的路径(仅 uid_unresolved 之外且解析成功时)。 */
  resolvedPath?: string;
  pathExists: boolean;
  detail?: string;
}

export interface UidDuplicate {
  uid: string;
  paths: string[];
}

export interface UidCheckReport {
  scanPath: string;
  filesScanned: number;
  references: number;
  ok: number;
  summary: Record<Exclude<UidStatus, "ok">, number>;
  issues: UidIssue[];
  duplicateUids: UidDuplicate[];
  /** 无法解析/读取的文件;不阻断其它文件的检查。 */
  errors: Array<{ file: string; message: string }>;
}

interface UidIndex {
  byUid: Map<string, string[]>;
}

const SCAN_EXTENSIONS = new Set([".tscn", ".tres"]);
const UID_TEXT_RE = /^uid:\/\/[a-z0-9]+$/i;

export class UidCheckService {
  constructor(private readonly resolver: ProjectResolver) {}

  /**
   * 扫描指定文件/目录(默认整个项目)中的 ExtResource 引用。
   * 只读:不写文件、不修复 UID、不修改索引。
   */
  check(projectPath: string | undefined, scanPath?: string): UidCheckReport {
    const root = this.resolver.resolve(projectPath);
    const guard = new FileGuard(root);
    const startAbs = scanPath === undefined || scanPath.trim() === "" ? root : guard.toAbsolute(scanPath);
    const startRes = guard.toRes(startAbs);
    if (!fs.existsSync(startAbs)) {
      throw new GodotMcpError("FILE_NOT_FOUND", `扫描路径不存在: ${startRes}`, { path: startAbs, resPath: startRes });
    }

    const index = buildUidIndex(root);
    const files = collectResourceFiles(startAbs);
    const summary: UidCheckReport["summary"] = {
      uid_missing: 0, path_missing: 0, uid_unresolved: 0, uid_mismatch: 0, unknown: 0,
    };
    const issues: UidIssue[] = [];
    const errors: Array<{ file: string; message: string }> = [];
    let references = 0;
    let ok = 0;

    for (const abs of files) {
      const fileRes = guard.toRes(abs);
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch (e) {
        errors.push({ file: fileRes, message: messageOf(e) });
        continue;
      }
      let ast;
      try {
        ast = parseGodotResource(text);
      } catch (e) {
        errors.push({ file: fileRes, message: messageOf(e) });
        continue;
      }
      for (const section of ast.sections) {
        if (section.tag !== "ext_resource") continue;
        references += 1;
        const issue = checkReference(root, fileRes, section.attributes, index);
        if (issue.status === "ok") { ok += 1; continue; }
        summary[issue.status] += 1;
        issues.push(issue);
      }
    }

    issues.sort((a, b) => a.file.localeCompare(b.file) || a.resourceId.localeCompare(b.resourceId));
    const duplicateUids = [...index.byUid.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([uid, paths]) => ({ uid, paths: [...paths].sort() }))
      .sort((a, b) => a.uid.localeCompare(b.uid));

    return {
      scanPath: startRes,
      filesScanned: files.length,
      references,
      ok,
      summary,
      issues,
      duplicateUids,
      errors: errors.sort((a, b) => a.file.localeCompare(b.file)),
    };
  }
}

// ────────────────────────────── 索引 ──────────────────────────────

function buildUidIndex(root: string): UidIndex {
  const byUid = new Map<string, string[]>();
  const add = (uid: string, resPath: string): void => {
    if (!UID_TEXT_RE.test(uid)) return;
    const list = byUid.get(uid) ?? [];
    if (!list.includes(resPath)) list.push(resPath);
    byUid.set(uid, list);
  };

  for (const abs of walkFiles(root)) {
    const ext = path.extname(abs).toLowerCase();
    const resPath = toRes(root, abs);
    try {
      if (ext === ".uid") {
        const uid = fs.readFileSync(abs, "utf8").trim();
        add(uid, toRes(root, abs.slice(0, -".uid".length)));
        continue;
      }
      if (ext === ".import") {
        const ast = parseGodotConfigFile(fs.readFileSync(abs, "utf8"));
        const raw = getGodotConfigValue(ast, "remap", "uid");
        if (raw !== undefined) add(decode(raw), toRes(root, abs.slice(0, -".import".length)));
        continue;
      }
      if (ext === ".tscn" || ext === ".tres") {
        const ast = parseGodotResource(fs.readFileSync(abs, "utf8"));
        const header = ast.sections.find((s) => s.tag === "gd_scene" || s.tag === "gd_resource");
        const raw = header?.attributes.find((a) => a.name === "uid")?.value;
        if (raw !== undefined) add(decode(raw), resPath);
      }
    } catch {
      // 索引构建失败不应中断检查;该文件自己的引用仍会在扫描阶段报告解析错误。
    }
  }
  return { byUid };
}

// ────────────────────────────── 单条引用 ──────────────────────────────

function checkReference(
  root: string,
  file: string,
  attributes: ReadonlyArray<{ name: string; value: string }>,
  index: UidIndex,
): UidIssue {
  const attr = (name: string): string | undefined => {
    const raw = attributes.find((a) => a.name === name)?.value;
    return raw === undefined ? undefined : decode(raw);
  };
  const resourceId = attr("id") ?? "(missing id)";
  const resourceType = attr("type");
  const uid = attr("uid");
  const declaredPath = attr("path");
  const base: UidIssue = {
    file, resourceId, ...(resourceType === undefined ? {} : { resourceType }),
    ...(uid === undefined ? {} : { uid }), ...(declaredPath === undefined ? {} : { path: declaredPath }),
    status: "unknown", pathExists: false,
  };

  if (declaredPath === undefined || declaredPath === "") {
    return {
      ...base, status: "path_missing",
      detail: "ext_resource has no path=; Godot cannot load it by path",
    };
  }
  const resolvedPath = resolveRes(root, declaredPath);
  if (resolvedPath === undefined) {
    return { ...base, status: "unknown", detail: `path is not a project-relative res:// path: ${declaredPath}` };
  }
  const pathExists = isFile(resolvedPath.absPath);
  if (!pathExists) {
    return { ...base, status: "path_missing", detail: `path does not exist: ${resolvedPath.resPath}` };
  }
  if (uid === undefined || uid === "") {
    return { ...base, status: "uid_missing", pathExists: true, detail: "reference has path= but no uid=" };
  }
  if (!UID_TEXT_RE.test(uid)) {
    return { ...base, status: "unknown", pathExists: true, detail: `malformed uid: ${uid}` };
  }
  const resolved = resolveUid(index, uid);
  if (resolved.ambiguous) {
    return {
      ...base, status: "unknown", pathExists: true,
      detail: `uid is mapped to multiple files: ${resolved.paths.join(", ")}`,
    };
  }
  if (resolved.path === undefined) {
    return { ...base, status: "uid_unresolved", pathExists: true, detail: "uid not found in .uid/.import/header index" };
  }
  if (!sameResPath(resolved.path, resolvedPath.resPath)) {
    return {
      ...base, status: "uid_mismatch", pathExists: true,
      resolvedPath: resolved.path,
      detail: `uid resolves to ${resolved.path} but path= points to ${resolvedPath.resPath}`,
    };
  }
  return { ...base, status: "ok", pathExists: true, resolvedPath: resolved.path };
}

function resolveUid(index: UidIndex, uid: string): { path?: string; paths: string[]; ambiguous: boolean } {
  const paths = index.byUid.get(uid) ?? [];
  return { ...(paths.length === 1 ? { path: paths[0] } : {}), paths, ambiguous: paths.length > 1 };
}

// ────────────────────────────── 文件系统 ──────────────────────────────

function collectResourceFiles(startAbs: string): string[] {
  const stat = fs.statSync(startAbs);
  if (stat.isFile()) return SCAN_EXTENSIONS.has(path.extname(startAbs).toLowerCase()) ? [startAbs] : [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".godot" || entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(abs);
    }
  };
  walk(startAbs);
  return out.sort();
}

/** 索引用:整棵项目树,跳过引擎缓存与 VCS。 */
function* walkFiles(root: string): Generator<string> {
  const walk = function* (dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".godot" || entry.name === ".git" || entry.name === ".vino-godot-mcp") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(abs);
      else yield abs;
    }
  };
  yield* walk(root);
}

/** `res://...` → 项目内绝对路径;越界或非 res:// 返回 undefined。 */
function resolveRes(root: string, resPath: string): { absPath: string; resPath: string } | undefined {
  if (!resPath.startsWith("res://")) return undefined;
  const absPath = path.resolve(root, resPath.slice("res://".length).replace(/\//g, path.sep));
  const rel = path.relative(root, absPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return { absPath, resPath: toRes(root, absPath) };
}

function toRes(root: string, abs: string): string {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return rel === "" ? "res://" : `res://${rel}`;
}

function isFile(absPath: string): boolean {
  try { return fs.statSync(absPath).isFile(); } catch { return false; }
}

function decode(raw: string): string {
  const t = raw.trim();
  if (t.length < 2 || t.charAt(0) !== '"' || t.charAt(t.length - 1) !== '"') return t;
  return t.slice(1, -1).replace(/\\(.)/g, "$1");
}

function sameResPath(a: string, b: string): boolean {
  const left = a.replace(/\\/g, "/");
  const right = b.replace(/\\/g, "/");
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

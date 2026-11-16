// 受保护目录 + 可覆盖扩展名策略。
// 分工:FileGuard 管"路径必须落在项目内",这里管"项目内哪些位置/哪些文件不许被覆盖"。
// 判定一律基于 FileGuard 已解析的路径与真实路径(realpath),因此 `..` 穿越、符号链接/junction
// 逃逸、Windows 大小写不敏感都已覆盖;不依赖调用方传进来的原始字符串。
//
// 三类目标(V1.2.2 P0-C):
//   engine    引擎生成物:项目根下的 `.godot/`、任意位置的 `.import`/`.uid` —— 任何工具都不覆盖/不新建。
//   strict    用户通过 VINO_GODOT_MCP_PROTECTED_DIRS 显式追加的目录 —— 既有文件完全不覆盖。
//   editable  默认保护目录 data / assets —— 只允许覆盖可编辑文本(.gd/.tscn/.tres/.gdshader/...),
//             二进制素材仍然拒绝。这样源码资源不会被"与导入缓存一视同仁"的策略误伤。
import path from "node:path";
import { GodotMcpError } from "../errors.js";
import { FileGuard, RES_PREFIX, within } from "./fileGuard.js";

/** 追加受保护目录的环境变量(逗号分隔的 `res://` 前缀)。默认两项始终生效,没有关闭开关。 */
export const PROTECTED_DIRS_ENV = "VINO_GODOT_MCP_PROTECTED_DIRS";

/** 默认受保护目录(项目相对路径,含所有子目录)。 */
export const DEFAULT_PROTECTED_DIRS: readonly string[] = ["data", "assets"];

/** Godot 引擎缓存目录(任意层级出现都按引擎生成物处理)。 */
export const ENGINE_CACHE_DIR = ".godot";

/** Godot 自己维护的旁路文件扩展名;写入会破坏引擎的导入/UID 映射。 */
export const ENGINE_OWNED_EXTENSIONS: readonly string[] = [".import", ".uid"];

/** overwrite=true 唯一允许覆盖的扩展名(文本类);其余一律拒绝,与目标目录无关。 */
export const OVERWRITABLE_TEXT_EXTENSIONS: readonly string[] = [
  ".gd", ".gdshader", ".gdshaderinc", ".tres", ".tscn", ".cfg", ".json", ".md", ".txt",
];

/** 会销毁既有内容、因而必须过受保护目录检查的操作(新建不存在文件不属于此类)。 */
export type ProtectedOp = "overwrite" | "delete" | "move" | "rename";

/** 保护级别。engine 最强,strict 次之,editable 允许覆盖文本源码。 */
export type ProtectionLevel = "engine" | "strict" | "editable";

export interface ProtectedRule {
  /** 项目相对 POSIX 目录。 */
  dir: string;
  level: Exclude<ProtectionLevel, "engine">;
}

export interface ProtectionVerdict {
  level: ProtectionLevel;
  /** 命中的受保护目录(engine 级别可能没有)。 */
  dir?: string;
  reason: "engine-cache" | "engine-owned-extension" | "protected-dir" | "readonly-in-protected-dir";
  detail?: string;
}

/**
 * 默认受保护目录 + 环境变量追加项。
 * 环境变量把默认目录再写一次时,该目录升级为 strict(用户显式要求硬保护)。
 */
export function protectedRules(env: NodeJS.ProcessEnv = process.env): ProtectedRule[] {
  const requested: string[] = [];
  const raw = env[PROTECTED_DIRS_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    for (const entry of raw.split(",")) {
      const dir = normalizeDirEntry(entry);
      if (dir !== undefined && !requested.includes(dir)) requested.push(dir);
    }
  }
  const rules: ProtectedRule[] = DEFAULT_PROTECTED_DIRS.map((dir) => ({
    dir,
    level: requested.includes(dir) ? "strict" : "editable",
  }));
  for (const dir of requested) if (!DEFAULT_PROTECTED_DIRS.includes(dir)) rules.push({ dir, level: "strict" });
  return rules;
}

/** 所有受保护目录(去重,用于错误信息与向后兼容)。 */
export function protectedDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return protectedRules(env).map((rule) => rule.dir);
}

/** 命中 `.godot/` 或 `.import`/`.uid` 时返回 engine 判定。 */
export function findEngineGenerated(guard: FileGuard, absPath: string): ProtectionVerdict | undefined {
  const resolved = path.resolve(absPath);
  const ext = path.extname(resolved).toLowerCase();
  if (ENGINE_OWNED_EXTENSIONS.includes(ext)) {
    return { level: "engine", reason: "engine-owned-extension", detail: ext };
  }
  const real = guard.realPath(resolved);
  const candidates = real === resolved ? [resolved] : [resolved, real];
  const roots = guard.realRoot === guard.root ? [guard.root] : [guard.root, guard.realRoot];
  for (const root of roots) {
    const cacheDir = path.resolve(root, ENGINE_CACHE_DIR);
    if (candidates.some((candidate) => within(cacheDir, candidate))) {
      return { level: "engine", reason: "engine-cache", dir: ENGINE_CACHE_DIR };
    }
  }
  return undefined;
}

/** 路径命中的受保护规则(engine 优先,其次目录规则);不在任何保护范围内返回 undefined。 */
export function classifyProtection(
  guard: FileGuard,
  absPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ProtectionVerdict | undefined {
  const engine = findEngineGenerated(guard, absPath);
  if (engine) return engine;

  const resolved = path.resolve(absPath);
  const real = guard.realPath(resolved);
  const candidates = real === resolved ? [resolved] : [resolved, real];
  const roots = guard.realRoot === guard.root ? [guard.root] : [guard.root, guard.realRoot];
  for (const rule of protectedRules(env)) {
    for (const root of roots) {
      const dirAbs = path.resolve(root, rule.dir);
      if (candidates.some((candidate) => within(dirAbs, candidate))) {
        return { level: rule.level, dir: rule.dir, reason: "protected-dir" };
      }
    }
  }
  return undefined;
}

/** 路径所在的受保护目录(项目相对 POSIX 形式);不在受保护目录内返回 undefined。 */
export function findProtectedDir(guard: FileGuard, absPath: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return classifyProtection(guard, absPath, env)?.dir;
}

/**
 * 覆盖/删除/移动既有内容前的守卫:
 *   engine  → 一律拒绝(引擎缓存、.import/.uid)。
 *   strict  → 一律拒绝(用户显式保护目录)。
 *   editable→ 仅 overwrite + 可编辑文本扩展名放行,其余拒绝。
 * 受保护目录内**新建**文件不走这里,由 assertCreatable 判定。
 */
export function assertWritable(
  guard: FileGuard,
  absPath: string,
  op: ProtectedOp = "overwrite",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const verdict = classifyProtection(guard, absPath, env);
  if (verdict === undefined) return;
  const target = describe(guard, absPath);

  if (verdict.level === "engine") {
    const what = verdict.reason === "engine-cache" ? `the engine cache directory "${RES_PREFIX}${ENGINE_CACHE_DIR}/"` : `a Godot-owned ${verdict.detail} file`;
    throw new GodotMcpError(
      "PROTECTED_PATH",
      `Refusing to ${op} "${target}": it is ${what}. Engine-generated files are always protected and cannot be replaced, moved or deleted by tools.`,
      { path: absPath, resPath: target, op, reason: verdict.reason, protectionLevel: verdict.level },
    );
  }

  if (verdict.level === "strict") {
    const protectedDir = RES_PREFIX + verdict.dir + "/";
    throw new GodotMcpError(
      "PROTECTED_PATH",
      `Refusing to ${op} "${target}": it is inside the user-protected directory "${protectedDir}" (${PROTECTED_DIRS_ENV}). `
      + "Directories added through that variable are hard-protected: no existing file there may be replaced, moved or deleted. "
      + "Remove the directory from the variable if you really want to edit it.",
      { path: absPath, resPath: target, protectedDir, protectedDirs: protectedDirs(env), op, reason: "protected-dir", protectionLevel: verdict.level },
    );
  }

  const ext = path.extname(absPath).toLowerCase();
  if (op === "overwrite" && OVERWRITABLE_TEXT_EXTENSIONS.includes(ext)) return;
  const protectedDir = RES_PREFIX + verdict.dir + "/";
  throw new GodotMcpError(
    "PROTECTED_PATH",
    `Refusing to ${op} "${target}": it is inside the protected directory "${protectedDir}", which only allows replacing editable text files `
    + `(${OVERWRITABLE_TEXT_EXTENSIONS.join(", ")}). Binary assets and engine products stay protected.`,
    {
      path: absPath, resPath: target, protectedDir, protectedDirs: protectedDirs(env), op,
      reason: "readonly-in-protected-dir", protectionLevel: verdict.level,
      extension: ext, allowedExtensions: [...OVERWRITABLE_TEXT_EXTENSIONS],
    },
  );
}

/** 新建文件前的守卫:引擎生成物(含 .godot/ 与 .import/.uid)不允许由工具创建;目录规则不限制新建。 */
export function assertCreatable(guard: FileGuard, absPath: string): void {
  const verdict = findEngineGenerated(guard, absPath);
  if (verdict === undefined) return;
  const target = describe(guard, absPath);
  throw new GodotMcpError(
    "PROTECTED_PATH",
    `Refusing to create "${target}": engine-generated paths are owned by Godot (${verdict.reason === "engine-cache" ? "inside .godot/" : verdict.detail}). `
    + "Let Godot create import products and UID files instead.",
    { path: absPath, resPath: target, reason: verdict.reason, protectionLevel: "engine" },
  );
}

/** 向后兼容入口:等价于 assertWritable(op)。 */
export function assertNotProtected(
  guard: FileGuard,
  absPath: string,
  op: ProtectedOp,
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertWritable(guard, absPath, op, env);
}

/** 覆盖既有文件只允许文本类扩展名;其他扩展名(含无扩展名)一律拒绝。 */
export function assertOverwritableExtension(
  guard: FileGuard,
  absPath: string,
  op: ProtectedOp = "overwrite",
): void {
  const ext = path.extname(absPath).toLowerCase();
  if (OVERWRITABLE_TEXT_EXTENSIONS.includes(ext)) return;
  const target = describe(guard, absPath);
  const shown = ext === "" ? "no extension" : `"${ext}"`;
  throw new GodotMcpError(
    "INVALID_ARGUMENT",
    `Refusing to ${op} "${target}": only text files may be replaced by this tool, but the path has ${shown}. `
    + `Allowed extensions: ${OVERWRITABLE_TEXT_EXTENSIONS.join(", ")}. `
    + "Binary assets must be changed outside of tools (or through a tool that owns that format).",
    { path: absPath, resPath: target, extension: ext, allowedExtensions: [...OVERWRITABLE_TEXT_EXTENSIONS], op, reason: "non-text-extension" },
  );
}

/** 报错用的展示路径:`res://…`;极端情况下退回绝对路径。 */
function describe(guard: FileGuard, absPath: string): string {
  try {
    return guard.toRes(absPath);
  } catch {
    return absPath;
  }
}

/**
 * `res://data/` / `data` / `data\sub` → `data/sub`。
 * 环境变量是进程级配置,单条写错不该让所有工具都报错,故无法安全解释的条目忽略。
 */
function normalizeDirEntry(entry: string): string | undefined {
  const raw = entry.trim().replace(/\\/g, "/").replace(/^res:\/\//, "");
  if (raw.includes("\0")) return undefined;
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..") || path.isAbsolute(raw)) return undefined;
  return segments.join("/");
}

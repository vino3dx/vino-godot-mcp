// 受保护目录 + 可覆盖扩展名策略。
// 分工:FileGuard 管"路径必须落在项目内",这里管"项目内哪些位置/哪些文件不许被覆盖"。
// 判定一律基于 FileGuard 已解析的路径与真实路径(realpath),因此 `..` 穿越、符号链接/junction
// 逃逸、Windows 大小写不敏感都已覆盖;不依赖调用方传进来的原始字符串。
import path from "node:path";
import { GodotMcpError } from "../errors.js";
import { FileGuard, RES_PREFIX, within } from "./fileGuard.js";

/** 追加受保护目录的环境变量(逗号分隔的 `res://` 前缀)。默认两项始终生效,没有关闭开关。 */
export const PROTECTED_DIRS_ENV = "VINO_GODOT_MCP_PROTECTED_DIRS";

/** 默认受保护目录(项目相对路径,含所有子目录)。 */
export const DEFAULT_PROTECTED_DIRS: readonly string[] = ["data", "assets"];

/** overwrite=true 唯一允许覆盖的扩展名(文本类);其余一律拒绝,与目标目录无关。 */
export const OVERWRITABLE_TEXT_EXTENSIONS: readonly string[] = [
  ".gd", ".gdshader", ".gdshaderinc", ".tres", ".tscn", ".cfg", ".json", ".md", ".txt",
];

/** 会销毁既有内容、因而必须过受保护目录检查的操作(新建不存在文件不属于此类)。 */
export type ProtectedOp = "overwrite" | "delete" | "move" | "rename";

/** 默认受保护目录 + 环境变量追加项(去重)。默认项不可被环境变量移除。 */
export function protectedDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [...DEFAULT_PROTECTED_DIRS];
  const raw = env[PROTECTED_DIRS_ENV];
  if (raw === undefined || raw.trim() === "") return out;
  for (const entry of raw.split(",")) {
    const dir = normalizeDirEntry(entry);
    if (dir !== undefined && !out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * 路径所在的受保护目录(项目相对 POSIX 形式);不在受保护目录内返回 undefined。
 * 名义路径与真实路径都要检查:项目内指向受保护目录的链接(res://link → res://data)不能绕过。
 */
export function findProtectedDir(guard: FileGuard, absPath: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const resolved = path.resolve(absPath);
  const real = guard.realPath(resolved);
  const candidates = real === resolved ? [resolved] : [resolved, real];
  const roots = guard.realRoot === guard.root ? [guard.root] : [guard.root, guard.realRoot];
  for (const dir of protectedDirs(env)) {
    for (const root of roots) {
      const dirAbs = path.resolve(root, dir);
      if (candidates.some((c) => within(dirAbs, c))) return dir;
    }
  }
  return undefined;
}

/**
 * 覆盖/删除/移动既有内容前的守卫:目标在受保护目录内 → PROTECTED_PATH。
 * 受保护目录内**新建**不存在的文件不走这里(允许)。
 */
export function assertNotProtected(
  guard: FileGuard,
  absPath: string,
  op: ProtectedOp,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = findProtectedDir(guard, absPath, env);
  if (dir === undefined) return;
  const target = describe(guard, absPath);
  const protectedDir = RES_PREFIX + dir + "/";
  const all = protectedDirs(env).map((d) => RES_PREFIX + d + "/").join(", ");
  throw new GodotMcpError(
    "PROTECTED_PATH",
    `Refusing to ${op} "${target}": it is inside the protected directory "${protectedDir}". `
    + "Protected directories hold real project data (imported assets, game modules, ...) and tools never "
    + "replace existing files there. There is no switch to disable them; "
    + `${PROTECTED_DIRS_ENV} can only add more. Protected: ${all}. `
    + "Pick another path, or create the file if it does not exist yet (creating is allowed).",
    { path: absPath, resPath: target, protectedDir, protectedDirs: protectedDirs(env), op, reason: "protected-dir" },
  );
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

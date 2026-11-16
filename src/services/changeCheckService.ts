// P1-C:批量文件漂移检查(只读)。
//
// 与 safeWriteFile 的 expectedHash 语义保持一致:sha256(hex)。
// 这里按磁盘原字节计算 —— 对合法 UTF-8 文本与 FileService.read 的文本哈希相同,
// 同时不会因为二进制/无效 UTF-8 而抛错。不写文件、不加锁、不做文件监控。
import fs from "node:fs";
import { GodotMcpError } from "../core/errors.js";
import { FileGuard } from "../core/filesystem/fileGuard.js";
import { sha256Hex } from "../core/filesystem/safeWrite.js";
import type { ProjectResolver } from "../core/project/projectResolver.js";

export type ChangeStatus = "unchanged" | "modified" | "missing" | "error";

export interface ChangeCheckInput {
  path: string;
  /** 调用方记录的 sha256(hex)。 */
  expectedHash: string;
}

export interface ChangeCheckResult {
  path: string;
  status: ChangeStatus;
  expectedHash: string;
  /** 文件存在且可读时的当前 sha256。 */
  currentHash?: string;
  error?: string;
}

export interface ChangeCheckReport {
  checkedAt: string;
  total: number;
  unchanged: string[];
  modified: string[];
  missing: string[];
  /** 无法读取(权限/IO/非普通文件)的条目;不影响其它文件。 */
  unreadable: string[];
  results: ChangeCheckResult[];
}

export class ChangeCheckService {
  constructor(private readonly resolver: ProjectResolver) {}

  check(projectPath: string | undefined, files: ReadonlyArray<ChangeCheckInput>): ChangeCheckReport {
    if (!Array.isArray(files)) {
      throw new GodotMcpError("INVALID_ARGUMENT", "files must be an array", { param: "files" });
    }
    const root = this.resolver.resolve(projectPath);
    const guard = new FileGuard(root);
    const seen = new Set<string>();
    const results: ChangeCheckResult[] = [];

    for (const entry of files) {
      if (typeof entry?.path !== "string" || entry.path.trim() === "") {
        throw new GodotMcpError("INVALID_ARGUMENT", "each entry needs a non-empty path", { entry });
      }
      if (typeof entry.expectedHash !== "string" || entry.expectedHash.trim() === "") {
        throw new GodotMcpError("INVALID_ARGUMENT", `entry "${entry.path}" needs a non-empty expectedHash`, { path: entry.path });
      }
      const absPath = guard.toAbsolute(entry.path);
      const resPath = guard.toRes(absPath);
      const key = process.platform === "win32" ? resPath.toLowerCase() : resPath;
      if (seen.has(key)) throw new GodotMcpError("INVALID_ARGUMENT", `duplicate path in files: ${resPath}`, { path: resPath });
      seen.add(key);

      const expectedHash = entry.expectedHash.trim().toLowerCase();
      const read = readFileHash(absPath);
      if (read.kind === "missing") {
        results.push({ path: resPath, status: "missing", expectedHash });
        continue;
      }
      if (read.kind === "error") {
        results.push({ path: resPath, status: "error", expectedHash, error: read.error });
        continue;
      }
      const status: ChangeStatus = read.hash === expectedHash ? "unchanged" : "modified";
      results.push({
        path: resPath, status, expectedHash,
        currentHash: read.hash,
      });
    }

    return {
      checkedAt: new Date().toISOString(),
      total: results.length,
      unchanged: results.filter((r) => r.status === "unchanged").map((r) => r.path),
      modified: results.filter((r) => r.status === "modified").map((r) => r.path),
      missing: results.filter((r) => r.status === "missing").map((r) => r.path),
      unreadable: results.filter((r) => r.status === "error").map((r) => r.path),
      results,
    };
  }
}

function readFileHash(absPath: string): { kind: "ok"; hash: string } | { kind: "missing" } | { kind: "error"; error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error: messageOf(e) };
  }
  if (!stat.isFile()) return { kind: "error", error: "not a regular file" };
  try {
    return { kind: "ok", hash: sha256Hex(fs.readFileSync(absPath)) };
  } catch (e) {
    return { kind: "error", error: messageOf(e) };
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

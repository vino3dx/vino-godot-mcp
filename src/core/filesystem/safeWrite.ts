import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../errors.js";
import { unifiedDiff } from "./unifiedDiff.js";

export interface SafeWriteOptions {
  /** 不落盘,只计算 changed / diff / newHash。 */
  dryRun?: boolean;
  /** 写入前校验磁盘上现有内容的 sha256(hex);不匹配(含"文件不存在")抛 FILE_CHANGED。 */
  expectedHash?: string;
  /**
   * 保留原始行尾,不做 LF 归一化。
   * 仅供回滚使用:把备份原文写回时必须逐字节恢复,包括 CRLF。
   */
  preserveLineEndings?: boolean;
}

export interface WriteOutcome {
  path: string;
  changed: boolean;
  /** 行级 unified diff;未改动时为空串。 */
  diff: string;
  /** 本次写入内容的 sha256(hex)。 */
  newHash: string;
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** 统一 LF:CRLF 与孤立 CR 都转成 \n。 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * 原子写:同目录临时文件 + rename,中途失败清理临时文件、不动原文件。
 * 内容统一 LF;可选 expectedHash(乐观并发)、dryRun(预演)。
 */
export async function safeWriteFile(absPath: string, content: string, opts: SafeWriteOptions = {}): Promise<WriteOutcome> {
  const target = path.resolve(absPath);
  const nextText = opts.preserveLineEndings === true ? content : normalizeEol(content);
  const nextBuf = Buffer.from(nextText, "utf8");
  const newHash = sha256Hex(nextBuf);

  const existing = await readIfRegularFile(target);
  if (opts.expectedHash !== undefined) {
    const actualHash = existing === undefined ? null : sha256Hex(existing);
    if (actualHash !== opts.expectedHash) {
      throw new GodotMcpError("FILE_CHANGED", `File changed on disk since it was read: ${target}`, {
        path: target, expectedHash: opts.expectedHash, actualHash,
      });
    }
  }

  const changed = existing === undefined || !existing.equals(nextBuf);
  const diff = changed
    ? unifiedDiff(existing === undefined ? "" : normalizeEol(existing.toString("utf8")), nextText, {
        aLabel: `a/${path.basename(target)}`, bLabel: `b/${path.basename(target)}`,
      })
    : "";

  if (changed && !opts.dryRun) await atomicWrite(target, nextBuf);
  return { path: target, changed, diff, newHash };
}

/** 目录、设备等非普通文件视作"无原内容"。 */
async function readIfRegularFile(p: string): Promise<Buffer | undefined> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new GodotMcpError("INTERNAL", `Cannot stat ${p}: ${message(e)}`, { path: p });
  }
  if (!st.isFile()) return undefined;
  return fs.promises.readFile(p);
}

async function atomicWrite(target: string, data: Buffer): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid.toString(36)}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  let handle: fs.promises.FileHandle | undefined;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    handle = await fs.promises.open(tmp, "wx", 0o644);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(tmp, target);
  } catch (e) {
    if (handle) { try { await handle.close(); } catch { /* 关闭失败无需处理,下面统一清理 */ } }
    await removeIfExists(tmp);
    if (await isDirectory(target)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `Cannot write "${target}": a directory exists at that path`, { path: target });
    }
    throw e instanceof GodotMcpError ? e : new GodotMcpError("INTERNAL", `Atomic write failed for ${target}: ${message(e)}`, { path: target });
  }
}

/** Windows 上 rename 可能被短暂占用,少量重试。 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const attempts = process.platform === "win32" ? 5 : 1;
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const retriable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (i >= attempts - 1 || !retriable) throw e;
      await new Promise((r) => setTimeout(r, 15 * (i + 1)));
    }
  }
}

async function removeIfExists(p: string): Promise<void> {
  try {
    await fs.promises.unlink(p);
  } catch { /* 已不存在或无法删除:不掩盖原始错误 */ }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

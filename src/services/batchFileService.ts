import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import { LockManager } from "../core/concurrency/lockManager.js";
import { safeWriteFile, sha256Hex, type SafeWriteOptions, type WriteOutcome } from "../core/filesystem/safeWrite.js";
import { FileService } from "./fileService.js";

export interface BatchChange { path: string; content: string; expectedHash?: string }
export interface BatchFileStatus {
  path: string;
  status: "ready" | "unchanged" | "written" | "restored" | "restore_failed" | "skipped";
  changed?: boolean;
  diff?: string;
  newHash?: string;
  /** 回滚失败时的当前磁盘 hash(便于判断残留内容)。 */
  currentHash?: string;
  /** true = 该文件可能仍保留本次提交写入的内容。 */
  residual?: boolean;
  error?: string;
}
export interface BatchPreview { mode: "preview"; committed: false; files: BatchFileStatus[]; valid: boolean }
export interface BatchCommit {
  mode: "commit";
  committed: boolean;
  recovered: boolean;
  recoveryComplete: boolean;
  /** 提交失败且无法确认已恢复的文件(res://);成功提交时为空数组。 */
  residualChanges: string[];
  files: BatchFileStatus[];
  warning: string;
}

interface Prepared { input: BatchChange; absPath: string; resPath: string; originalText: string; outcome: WriteOutcome }
export type BatchWriter = (absPath: string, content: string, opts?: SafeWriteOptions) => Promise<WriteOutcome>;

export class BatchFileService {
  constructor(private readonly file: FileService, private readonly locks: LockManager, private readonly writer: BatchWriter = safeWriteFile) {}

  async apply(projectPath: string | undefined, changes: BatchChange[], mode: "preview" | "commit", tool: string): Promise<BatchPreview | BatchCommit> {
    const duplicate = new Set<string>();
    const files: BatchFileStatus[] = [];
    const prepared: Prepared[] = [];
    for (const c of changes) {
      const read = this.file.read(projectPath, c.path);
      // 与 createText/editText 共用同一保护规则:预览阶段就拒绝,不能等到写盘。
      this.file.assertOverwriteTarget(projectPath, c.path);
      if (duplicate.has(read.absPath.toLowerCase())) throw new GodotMcpError("INVALID_ARGUMENT", `重复的批量目标路径: ${c.path}`, { path: c.path });
      duplicate.add(read.absPath.toLowerCase());
      const outcome = await this.writer(read.absPath, c.content, { dryRun: true, expectedHash: c.expectedHash ?? read.hash });
      // 保存原文文本(含原始行尾),回滚时以 preserveLineEndings 写回,保证字节级恢复。
      prepared.push({ input: c, absPath: read.absPath, resPath: read.resPath, originalText: read.text, outcome });
      files.push({ path: read.resPath, status: outcome.changed ? "ready" : "unchanged", changed: outcome.changed, diff: outcome.diff, newHash: outcome.newHash });
    }
    if (mode === "preview") return { mode, committed: false, files, valid: true };

    const keys = prepared.map((p) => p.absPath);
    return this.locks.withLocks(keys, { tool, target: projectPath ?? "project" }, async () => {
      // Re-check while holding every lock: the preview may have become stale.
      for (const p of prepared) {
        this.file.assertOverwriteTarget(projectPath, p.resPath);
        await this.writer(p.absPath, p.input.content, { dryRun: true, expectedHash: p.input.expectedHash ?? sha256Hex(p.originalText) });
      }
      const written: Prepared[] = [];
      try {
        for (const p of prepared) {
          const outcome = await this.writer(p.absPath, p.input.content, { expectedHash: p.input.expectedHash ?? sha256Hex(p.originalText) });
          const row = rowFor(files, p.resPath);
          row.status = outcome.changed ? "written" : "unchanged"; row.changed = outcome.changed; row.newHash = outcome.newHash; written.push(p);
        }
        return {
          mode, committed: true, recovered: false, recoveryComplete: true, residualChanges: [], files,
          warning: "多文件提交使用逐文件原子写入，不具备文件系统级原子性。",
        };
      } catch (e) {
        let recovered = true;
        const residual: string[] = [];
        // 逆序回滚:写入前已保存原文,回滚必须保留原始行尾(CRLF 不能被改成 LF)。
        for (const p of written.reverse()) {
          const row = rowFor(files, p.resPath);
          try {
            const current = fs.readFileSync(p.absPath);
            await this.writer(p.absPath, p.originalText, {
              expectedHash: sha256Hex(current),
              preserveLineEndings: true,
            });
            row.status = "restored";
          } catch (restoreError) {
            recovered = false;
            row.status = "restore_failed";
            row.residual = true;
            row.error = restoreError instanceof Error ? restoreError.message : String(restoreError);
            try { row.currentHash = sha256Hex(fs.readFileSync(p.absPath)); } catch { /* 文件可能已不可读;仍按残留处理 */ }
            residual.push(p.resPath);
          }
        }
        for (const row of files.filter((f) => f.status === "ready")) row.status = "skipped";
        const residualNote = residual.length === 0
          ? ""
          : ` 残留修改(回滚失败,需人工检查): ${residual.join(", ")}.`;
        return {
          mode, committed: false, recovered, recoveryComplete: recovered, residualChanges: residual, files,
          warning: `多文件提交失败，已尝试恢复；此操作不具备文件系统级原子性。${residualNote} 原始错误: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    });
  }
}

/** 按规范化 res 路径取行;找不到时抛错(调用方已按同一路径建立行)。 */
function rowFor(files: BatchFileStatus[], resPath: string): BatchFileStatus {
  const row = files.find((f) => f.path === resPath);
  if (!row) throw new GodotMcpError("INTERNAL", `批量写入状态行缺失: ${resPath}`, { resPath });
  return row;
}

// T07:导出产物的"暂存 → 提交"。
//
// 为什么不是"直接导出到正式路径再清理":
//   Godot 一次导出会在目标旁边写出主产物 + 可能的附带产物(.pck 等),取消时我们只知道
//   "任务被中断",无法可靠区分"本次写的半成品"和"上一次构建留下的文件"。直接覆盖就是
//   在赌,一旦取消,用户原来的构建产物已经被截断。
//
// 所以:先导出到系统临时目录下的任务专属 staging 目录(不碰用户任何文件),
//   成功 → 提交(把 staging 里的产物移动到正式路径);
//   取消/失败 → 丢弃 staging。正式路径在整个过程中**完全没有被触碰**,自然满足"绝不删除任务开始前就存在的文件"。
//
// 提交本身也不能"先删后搬"(T07-C1):staging 在系统临时目录,工程常在另一个盘,
// 跨盘 rename 一定 EXDEV,只能复制。一旦"先删目标再复制"时复制失败,旧构建就没了。
// 现在的顺序是:
//   1) 准备:把新产物搬到**目标目录内**的临时名(.name.new-<uuid>)—— 正式目标仍未动;
//      同盘是 rename(零拷贝),跨盘先在目标盘落地完整副本;
//   2) 备份:把旧目标改名为 .name.old-<uuid>(同目录 = 同盘,只改名);
//   3) 替换:准备物 rename 成正式名(同目录,原子);
//   4) 回滚:替换失败就把备份改回原名;回滚不了必须把两个路径都交出去;
//   5) 收尾:确认新产物已就位后才删备份,删不掉只作为 warning 报告。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";

/** staging 根目录(系统临时目录下,与截图/临时脚本同一套约定)。 */
export const EXPORT_STAGING_ROOT = path.join(os.tmpdir(), "vino-godot-mcp", "exports");

export interface ExportStaging {
  /** 调用方要求的路径(原样,用于报告与错误信息)。 */
  requestedPath: string;
  /** 解析后的绝对目标路径。 */
  finalPath: string;
  /** 任务专属 staging 目录。 */
  stagingDir: string;
  /** 交给 Godot 的输出路径(staging 内的同名文件/目录)。 */
  stagingOutputPath: string;
  /** 目标是否按"目录"处理(路径以分隔符结尾,或已存在且是目录)。 */
  targetIsDirectory: boolean;
}

/** 提交阶段用到的文件操作。抽成接口只为了可测:跨盘复制失败/替换失败无法在单机上稳定制造。 */
export interface ExportFsOps {
  existsSync(p: string): boolean;
  renameSync(from: string, to: string): void;
  cpSync(from: string, to: string): void;
  rmSync(p: string): void;
}

const REAL_FS_OPS: ExportFsOps = {
  existsSync: (p) => fs.existsSync(p),
  renameSync: (from, to) => fs.renameSync(from, to),
  cpSync: (from, to) => fs.cpSync(from, to, { recursive: true }),
  rmSync: (p) => fs.rmSync(p, { recursive: true, force: true }),
};

export interface ExportCommitResult {
  /** 是否真的移动了产物。false = staging 为空(引擎没写任何文件),正式路径未动。 */
  committed: boolean;
  /** 已移动到正式路径的文件(绝对路径)。 */
  moved: string[];
  warnings: string[];
}

export interface ExportDiscardResult {
  /** 没能清理掉的残留(绝对路径);空数组 = 清干净了。 */
  residual: string[];
  warnings: string[];
}

/**
 * 建立 staging。只写系统临时目录,不创建、不修改目标目录下的任何东西。
 *
 * `requestedPath` 的解释与 Godot CLI 一致:MCP 进程 cwd 相对路径。
 */
export function createExportStaging(requestedPath: string): ExportStaging {
  const finalPath = path.resolve(requestedPath);
  const stagingDir = path.join(EXPORT_STAGING_ROOT, `export-${randomUUID()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  let targetIsDirectory = /[\\/]$/.test(requestedPath);
  if (!targetIsDirectory) {
    try { targetIsDirectory = fs.statSync(finalPath).isDirectory(); }
    catch { targetIsDirectory = false; } // 不存在 = 按文件处理
  }
  // 文件目标用原文件名(便于 Godot 推导 .pck 等附带产物的名字);目录目标用固定子目录。
  const stagingOutputPath = targetIsDirectory
    ? path.join(stagingDir, "out")
    : path.join(stagingDir, path.basename(finalPath));
  return { requestedPath, finalPath, stagingDir, stagingOutputPath, targetIsDirectory };
}

/**
 * 提交:把 staging 里的产物移动到正式路径。
 * 只有到这里才会触碰用户目录,且只在导出成功之后。
 */
export function commitExportStaging(s: ExportStaging, ops: ExportFsOps = REAL_FS_OPS): ExportCommitResult {
  const warnings: string[] = [];
  const moved: string[] = [];
  if (!ops.existsSync(s.stagingDir)) {
    return { committed: false, moved, warnings: [`Export staging directory disappeared: ${s.stagingDir}`] };
  }
  const entries = fs.readdirSync(s.stagingDir, { withFileTypes: true });
  if (entries.length === 0) {
    // 引擎返回成功却没写文件(某些预设/测试替身):不动正式路径,如实说明。
    return { committed: false, moved, warnings: [`Export reported success but produced no files in ${s.stagingDir}; the target path was left untouched.`] };
  }

  const targetDir = s.targetIsDirectory ? s.finalPath : path.dirname(s.finalPath);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of entries) {
    const from = path.join(s.stagingDir, entry.name);
    const to = s.targetIsDirectory
      ? path.join(s.finalPath, entry.name)
      : entry.name === path.basename(s.finalPath) ? s.finalPath : path.join(targetDir, entry.name);
    const outcome = replacePath(from, to, ops);
    if (!outcome.ok) {
      throw new GodotMcpError("RUNTIME_FAILED", `Export succeeded but moving the build into place failed: ${to}`, {
        outputPath: s.finalPath,
        stagingDir: s.stagingDir,
        committedFiles: moved,
        phase: outcome.phase,
        previousBuildRestored: outcome.restored,
        error: outcome.reason,
        cleanup: { residual: outcome.residual.length > 0 ? outcome.residual : [s.stagingDir], error: outcome.reason },
        hint: outcome.restored
          ? "The previous build at outputPath was left in place. The new build was not committed; any leftover copy is listed in cleanup.residual."
          : "Both the previous build backup and the new build are listed in cleanup.residual; restore the backup manually before retrying.",
      });
    }
    // 提交成功但清理备份失败:产物已经就位,这是 warning 而不是失败。
    warnings.push(...outcome.warnings);
    moved.push(to);
  }
  // staging 空了就删掉;删不掉只是临时目录残留,不影响正式产物。
  try { ops.rmSync(s.stagingDir); }
  catch (e) { warnings.push(`Could not remove export staging directory ${s.stagingDir}: ${describeError(e)}`); }
  return { committed: true, moved, warnings };
}

/**
 * 丢弃 staging(取消 / 失败)。永不碰正式路径 —— 这正是取消安全的来源。
 * 删除失败不算致命错误,但要作为 residual 回报,不能假装清干净了。
 */
export function discardExportStaging(s: ExportStaging): ExportDiscardResult {
  const residual: string[] = [];
  const warnings: string[] = [];
  if (fs.existsSync(s.stagingDir)) {
    try { fs.rmSync(s.stagingDir, { recursive: true, force: true }); }
    catch (e) {
      residual.push(s.stagingDir);
      warnings.push(`Could not remove export staging directory ${s.stagingDir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { residual, warnings };
}

/** 提交结果:成功时带 warning(备份清理失败),失败时带阶段、是否已回滚、残留路径。 */
type ReplaceOutcome =
  | { ok: true; warnings: string[] }
  | { ok: false; phase: "prepare" | "swap"; reason: string; restored: boolean; residual: string[] };

/**
 * 把一个产物从 staging 换到正式路径,全程保证"正式目标在新产物完整准备好之前不变"。
 *
 * 辅助名都放在**目标目录**内(同盘),因此:
 *   - 跨盘的复制只发生一次,且落在目标盘的临时名上,不是直接写正式名;
 *   - 备份与替换都是同目录 rename(不跨盘、不复制)。
 */
function replacePath(from: string, to: string, ops: ExportFsOps): ReplaceOutcome {
  const targetDir = path.dirname(to);
  const base = path.basename(to);
  const tag = randomUUID();
  const prepared = path.join(targetDir, `.${base}.new-${tag}`);
  const backup = path.join(targetDir, `.${base}.old-${tag}`);

  // 1) 准备:新产物先成为目标盘上的完整副本,正式目标此时仍未动。
  try {
    try {
      ops.renameSync(from, prepared); // 同盘:原子改名,零拷贝
    } catch (e) {
      if (errorCode(e) !== "EXDEV") throw e;
      ops.cpSync(from, prepared); // 跨盘:复制到目标盘内的临时名
    }
  } catch (e) {
    const residual: string[] = [];
    try { ops.rmSync(prepared); } catch { residual.push(prepared); } // 写了一半的副本,清不掉就报
    return { ok: false, phase: "prepare", reason: describeError(e), restored: true, residual };
  }

  // 2) 备份旧目标(同目录改名,不复制)。失败时正式目标仍然原封不动。
  const hadTarget = ops.existsSync(to);
  if (hadTarget) {
    try {
      ops.renameSync(to, backup);
    } catch (e) {
      // 准备物里是唯一一份新产物:不删它,作为残留交出去(此时同盘 rename 已经搬走了 staging 里的原件)。
      const residual = ops.existsSync(prepared) ? [prepared] : [];
      return {
        ok: false, phase: "swap", restored: true, residual,
        reason: `could not move the previous build aside: ${describeError(e)}`,
      };
    }
  }

  // 3) 替换:准备物改名成正式名(同目录,原子)。
  try {
    ops.renameSync(prepared, to);
  } catch (e) {
    // 4) 回滚:尽量把旧目标放回原名。回不来就把备份与准备物都交出去,让调用方能手工恢复。
    let restored = !hadTarget; // 本来就没有旧目标 = 无需恢复
    if (hadTarget) {
      try { ops.renameSync(backup, to); restored = true; } catch { /* 见下面的 residual */ }
    }
    const residual: string[] = [];
    if (!restored && ops.existsSync(backup)) residual.push(backup);
    if (ops.existsSync(prepared)) residual.push(prepared);
    return {
      ok: false, phase: "swap", restored, residual,
      reason: `could not move the new build into place: ${describeError(e)}`,
    };
  }

  // 5) 新产物已就位,才允许删旧备份;删不掉只报告,不假装没发生。
  const warnings: string[] = [];
  if (hadTarget) {
    try { ops.rmSync(backup); }
    catch (e) {
      warnings.push(`New build is in place, but the previous build backup could not be removed: ${backup} (${describeError(e)})`);
    }
  }
  return { ok: true, warnings };
}

/** errno 码;非系统异常返回 undefined。 */
function errorCode(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

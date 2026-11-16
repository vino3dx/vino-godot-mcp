// FileService:tools 层访问项目文件的最小入口(架构测试强制 tools 只能经 Service 访问底层)。
// 读:FileGuard 把 res:// 限在项目内 + 同步读 UTF-8 文本 + sha256。
// 写:复用 core/filesystem/safeWrite(原子写、LF、dryRun、expectedHash 乐观并发)。
import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import { FileGuard } from "../core/filesystem/fileGuard.js";
import { assertCreatable, assertOverwritableExtension, assertWritable } from "../core/filesystem/protectedPaths.js";
import { safeWriteFile, sha256Hex, type WriteOutcome } from "../core/filesystem/safeWrite.js";
import { ProjectResolver } from "../core/project/projectResolver.js";

export interface ReadResult {
  /** 项目内规范化绝对路径 */
  absPath: string;
  /** res:// 形式 */
  resPath: string;
  /** 文件原文(UTF-8) */
  text: string;
  /** 磁盘原字节的 sha256(hex),可直接作为 expectedHash 回传 */
  hash: string;
}

export interface EditOptions {
  dryRun?: boolean;
  /** 调用方认为的当前内容 sha256;缺省时退化为"本服务刚读到的 hash"(仍防并发改写) */
  expectedHash?: string;
}

export interface EditResult extends WriteOutcome {
  resPath: string;
}

export interface CreateOptions {
  /** true 允许覆盖已存在的文件;缺省 false(已存在则抛 INVALID_ARGUMENT)。 */
  overwrite?: boolean;
  dryRun?: boolean;
  /** 仅 overwrite=true 时生效:磁盘上现有内容的 sha256;不匹配抛 FILE_CHANGED。 */
  expectedHash?: string;
}

export class FileService {
  constructor(private readonly resolver: ProjectResolver) {}

  private guard(projectPath?: string): FileGuard {
    return new FileGuard(this.resolver.resolve(projectPath));
  }

  /** 读项目内文件(按 res:// 定位)。不存在抛 FILE_NOT_FOUND。 */
  read(projectPath: string | undefined, resPath: string): ReadResult {
    const guard = this.guard(projectPath);
    const absPath = guard.toAbsolute(resPath);
    let text: string;
    try {
      text = fs.readFileSync(absPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GodotMcpError("FILE_NOT_FOUND", `文件不存在: ${resPath}`, { path: absPath, resPath });
      }
      throw e;
    }
    return { absPath, resPath: guard.toRes(absPath), text, hash: sha256Hex(text) };
  }

  /**
   * 只做保护规则检查,不读内容、不写盘 —— 供批量写入在预览/提交前复用同一套规则,
   * 避免 project_apply_changes 绕过 createText/editText 的保护。
   */
  assertOverwriteTarget(projectPath: string | undefined, resPath: string): void {
    const guard = this.guard(projectPath);
    assertWritable(guard, guard.toAbsolute(resPath), "overwrite");
  }

  listTextFiles(projectPath: string | undefined, extension = ".gd"): ReadResult[] {
    const guard = this.guard(projectPath);
    const root = guard.root;
    const out: ReadResult[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".godot" || entry.name === ".git") continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        if (path.extname(entry.name).toLowerCase() !== extension.toLowerCase()) continue;
        out.push(this.read(projectPath, guard.toRes(abs)));
      }
    };
    walk(root);
    return out.sort((a, b) => a.resPath.localeCompare(b.resPath));
  }

  /**
   * 读 → 就地变换 → 原子写回。edit 返回相同文本时自动跳过写盘(changed=false)。
   * 写入前应用统一保护策略:`.godot/`、`.import`、`.uid` 与 strict 目录一律拒绝;
   * 默认保护目录内只允许可编辑文本(点编辑不套用扩展名白名单,因为 project.godot 等文件不在白名单里)。
   */
  async editText(
    projectPath: string | undefined,
    resPath: string,
    edit: (text: string) => string,
    opts: EditOptions = {},
  ): Promise<EditResult> {
    const read = this.read(projectPath, resPath);
    assertWritable(new FileGuard(this.resolver.resolve(projectPath)), read.absPath, "overwrite");
    const next = edit(read.text);
    const outcome = await safeWriteFile(read.absPath, next, {
      dryRun: opts.dryRun,
      expectedHash: opts.expectedHash ?? read.hash,
    });
    return { ...outcome, resPath: read.resPath };
  }

  /**
   * 新建项目内文本文件(目录不存在时一并创建;内容统一 LF)。
   * overwrite=false(默认)时文件已存在抛 INVALID_ARGUMENT;overwrite=true 时可带 expectedHash 做乐观并发。
   * 路径越界 / `..` / `user://` 由 FileGuard 拒绝。
   * 覆盖既有文件时额外受 core/filesystem/protectedPaths 约束:受保护目录 → PROTECTED_PATH;
   * 只有文本类扩展名可被覆盖。目录/设备等非普通文件不适用(交给 safeWrite 报错),受保护目录内新建文件允许。
   */
  async createText(
    projectPath: string | undefined,
    resPath: string,
    content: string,
    opts: CreateOptions = {},
  ): Promise<EditResult> {
    const guard = this.guard(projectPath);
    const absPath = guard.toAbsolute(resPath);
    if (opts.overwrite !== true && fs.existsSync(absPath)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `文件已存在(overwrite=false,拒绝覆盖): ${resPath}`, {
        path: absPath, resPath,
      });
    }
    if (opts.overwrite === true && isExistingFile(absPath)) {
      assertWritable(guard, absPath, "overwrite");
      assertOverwritableExtension(guard, absPath);
    } else if (!fs.existsSync(absPath)) {
      assertCreatable(guard, absPath);
    }
    const outcome = await safeWriteFile(absPath, content, {
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      // 新建(overwrite=false)时文件必须不存在,expectedHash 无意义且会导致 FILE_CHANGED
      ...(opts.overwrite === true && opts.expectedHash !== undefined ? { expectedHash: opts.expectedHash } : {}),
    });
    return { ...outcome, resPath: guard.toRes(absPath) };
  }
}

/** 目标是已存在的普通文件(跟随符号链接)。目录/设备/不存在的路径都返回 false。 */
function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ProjectInitService:从零初始化一个 Godot 4.x 项目(T028)。
//
// 为什么必须单独一个 Service:其它所有服务都经 ProjectResolver.resolve() 拿项目根,而本工具的前提
// 恰恰是"项目还不存在"(没有 project.godot),resolve() 会直接抛 PROJECT_NOT_FOUND。所以这里
// 只接受调用方显式传入的**绝对路径**,绝不回落到 MCP 进程 cwd。
// 路径安全仍然走 FileGuard(越界 / .. / 软链逃逸一律拒绝),落盘仍然走 core/filesystem/safeWrite
// (同目录临时文件 + rename 的原子写,可 dryRun),覆盖保护仍然走 core/filesystem/protectedPaths。
//
// 生成内容只用模板拼装,不依赖引擎版本:config/features 故意不写 —— dependency 为 none 的工具
// 无从得知目标引擎版本,写错反而会让编辑器弹出"工程由更老/更新版本创建"的升级提示;Godot 首次
// 保存工程时会自己补上。
import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import { FileGuard, RES_PREFIX } from "../core/filesystem/fileGuard.js";
import { assertCreatable, assertWritable } from "../core/filesystem/protectedPaths.js";
import { safeWriteFile, sha256Hex } from "../core/filesystem/safeWrite.js";

/** Godot 用来识别项目根的文件名(与 ProjectResolver 保持一致)。 */
export const PROJECT_INIT_MARKER = "project.godot";

/** 未指定 mainScene 时使用的主场景路径。 */
export const DEFAULT_MAIN_SCENE = "res://main.tscn";

/** Godot 4.x 的三种 renderer 方法(写入 rendering/renderer/rendering_method)。 */
export const RENDERER_METHODS = ["forward_plus", "mobile", "gl_compatibility"] as const;
export type RendererMethod = (typeof RENDERER_METHODS)[number];
export const DEFAULT_RENDERER: RendererMethod = "forward_plus";

/** createDefaultDirs=true 时初始化的标准目录骨架(不写占位文件)。 */
export const DEFAULT_PROJECT_DIRS = ["scenes", "scripts", "assets"] as const;

/** 初始化时总会考虑生成的 .gitignore(已存在则跳过,绝不修改)。 */
export const GITIGNORE_NAME = ".gitignore";

export interface ProjectInitOptions {
  /** 目标项目根目录(必须是绝对路径;不接受 cwd 回落)。 */
  projectPath: string;
  /** 写入 [application] config/name。 */
  projectName: string;
  /** 写入 [application] run/main_scene。默认 res://main.tscn。 */
  mainScene?: string;
  /** 是否生成主场景骨架文件(.tscn)。默认 true。 */
  createMainScene?: boolean;
  /** 是否创建 scenes/ scripts/ assets/。默认 true。 */
  createDefaultDirs?: boolean;
  /** 写入 [rendering] renderer/rendering_method。默认 forward_plus。 */
  renderer?: RendererMethod;
  /** 允许重写已存在项目(默认 false:已存在 project.godot 时以 ALREADY_EXISTS 拒绝)。 */
  overwrite?: boolean;
  /** 只预览将要创建的目录与文件内容,零写盘。 */
  dryRun?: boolean;
}

/** planned=仅预览;existing=已存在未动;created=本次新建;updated=本次重写。 */
export type ProjectInitDirStatus = "planned" | "existing" | "created";
export type ProjectInitFileStatus = "planned" | "created" | "updated" | "unchanged" | "skipped";

export interface ProjectInitDirReport {
  resPath: string;
  absPath: string;
  status: ProjectInitDirStatus;
}

export interface ProjectInitFileReport {
  resPath: string;
  absPath: string;
  status: ProjectInitFileStatus;
  /** 内容的 sha256(与实际落盘内容一致,可直接当 expectedHash 用);skipped 时是既有文件的 hash。 */
  hash: string;
  bytes: number;
  /** 未写入的原因(skipped 时给出)。 */
  reason?: string;
  /** dryRun 预览:将要写入的完整内容。 */
  content?: string;
  /** 有既有内容且内容会变化时的 unified diff。 */
  diff?: string;
}

export interface ProjectInitResult {
  projectRoot: string;
  projectName: string;
  renderer: RendererMethod;
  /** run/main_scene 的 res:// 形式(即使 createMainScene=false 也会写入配置)。 */
  mainScene: string;
  dryRun: boolean;
  overwrite: boolean;
  dirs: ProjectInitDirReport[];
  files: ProjectInitFileReport[];
}

interface PlannedFile {
  resPath: string;
  absPath: string;
  content: string;
  /** project.godot 最后写:中途失败时目录里不会留下"半个工程"。 */
  role: "project" | "gitignore" | "mainScene";
}

export class ProjectInitService {
  /**
   * 初始化项目。已存在 project.godot 且 overwrite=false 时抛 ALREADY_EXISTS(先于任何写盘)。
   * dryRun=true 只返回预览(dirs/files 状态为 planned),不建目录、不写文件。
   */
  async init(opts: ProjectInitOptions): Promise<ProjectInitResult> {
    const root = assertProjectRoot(opts.projectPath);
    const projectName = assertProjectName(opts.projectName);
    const renderer = assertRenderer(opts.renderer);
    const overwrite = opts.overwrite === true;
    const dryRun = opts.dryRun === true;
    const createMainScene = opts.createMainScene !== false;
    const createDefaultDirs = opts.createDefaultDirs !== false;

    const guard = new FileGuard(root);
    const projectAbs = guard.assertInside(path.join(root, PROJECT_INIT_MARKER));

    // 幂等与防覆盖:必须在建目录/写文件之前拒绝,否则会留下空目录或半成品。
    if (!overwrite && isFile(projectAbs)) {
      throw new GodotMcpError(
        "ALREADY_EXISTS",
        `A Godot project already exists here: ${projectAbs}. Refusing to touch it (overwrite=false). `
        + "Pass overwrite=true only if you really want project.godot regenerated.",
        { projectPath: root, projectFile: projectAbs, marker: PROJECT_INIT_MARKER, overwrite: false },
      );
    }

    // mainScene 总是写进 run/main_scene(默认 res://main.tscn);只有 createMainScene 时才生成骨架。
    const mainSceneAbs = guard.toAbsolute(opts.mainScene ?? DEFAULT_MAIN_SCENE);
    const mainScene = guard.toRes(mainSceneAbs);
    if (mainScene === RES_PREFIX) {
      throw new GodotMcpError("INVALID_ARGUMENT", "mainScene must point to a scene file, not the project root", {
        mainScene: opts.mainScene, resolved: mainScene,
      });
    }
    if (createMainScene && !mainScene.toLowerCase().endsWith(".tscn")) {
      throw new GodotMcpError(
        "INVALID_ARGUMENT",
        `mainScene must be a .tscn file when createMainScene=true: ${mainScene}`,
        { mainScene: opts.mainScene, resolved: mainScene, createMainScene: true },
      );
    }

    const dirsPlan = createDefaultDirs
      ? DEFAULT_PROJECT_DIRS.map((name) => {
        const absPath = guard.assertInside(path.join(root, name));
        return { resPath: guard.toRes(absPath), absPath };
      })
      : [];

    const gitignoreAbs = guard.assertInside(path.join(root, GITIGNORE_NAME));
    const filesPlan: PlannedFile[] = [
      {
        resPath: guard.toRes(projectAbs), absPath: projectAbs, role: "project",
        content: projectGodotText({ name: projectName, mainScene, renderer }),
      },
      { resPath: guard.toRes(gitignoreAbs), absPath: gitignoreAbs, role: "gitignore", content: GITIGNORE_TEXT },
    ];
    if (createMainScene) {
      filesPlan.push({ resPath: mainScene, absPath: mainSceneAbs, role: "mainScene", content: MAIN_SCENE_TEXT });
    }

    // 1) 目录骨架(先建目录,再写文件)。
    const dirs: ProjectInitDirReport[] = [];
    for (const plan of dirsPlan) {
      if (isDirectory(plan.absPath)) {
        dirs.push({ ...plan, status: "existing" });
        continue;
      }
      if (!dryRun) await fs.promises.mkdir(plan.absPath, { recursive: true });
      dirs.push({ ...plan, status: dryRun ? "planned" : "created" });
    }

    // 2) 文件:project.godot 放最后写,失败时不会留下"半个工程"。
    const writeOrder = [
      ...filesPlan.filter((f) => f.role !== "project"),
      ...filesPlan.filter((f) => f.role === "project"),
    ];
    const reports = new Map<string, ProjectInitFileReport>();
    for (const plan of writeOrder) {
      reports.set(plan.resPath, await this.writePlan(guard, plan, { overwrite, dryRun }));
    }

    return {
      projectRoot: root,
      projectName,
      renderer,
      mainScene,
      dryRun,
      overwrite,
      dirs,
      files: filesPlan.map((plan) => reports.get(plan.resPath)!),
    };
  }

  /** 单个文件:既有则过覆盖保护,新建则过受保护路径检查,然后原子写(或 dryRun 预览)。 */
  private async writePlan(
    guard: FileGuard,
    plan: PlannedFile,
    opts: { overwrite: boolean; dryRun: boolean },
  ): Promise<ProjectInitFileReport> {
    const existingBytes = readIfFile(plan.absPath);
    const base = { resPath: plan.resPath, absPath: plan.absPath };

    // 只有 project.godot 会被 overwrite=true 重写:它是本工具的产物,重建不会丢用户内容。
    // .gitignore 与主场景都是"只新建"文件 —— 用空骨架盖掉用户已有的主场景是数据丢失,永远不做。
    const replaceExisting = plan.role === "project" && opts.overwrite;
    if (existingBytes !== undefined && !replaceExisting) {
      return {
        ...base,
        status: "skipped",
        hash: sha256Hex(existingBytes),
        bytes: existingBytes.length,
        reason: plan.role === "gitignore"
          ? "an existing .gitignore is never modified by this tool"
          : "file already exists and is create-only (only project.godot is rewritten by overwrite=true)",
      };
    }

    if (existingBytes === undefined) {
      assertCreatable(guard, plan.absPath);
    } else {
      assertWritable(guard, plan.absPath, "overwrite");
    }

    const outcome = await safeWriteFile(plan.absPath, plan.content, { dryRun: opts.dryRun });
    const status: ProjectInitFileStatus = opts.dryRun
      ? "planned"
      : existingBytes === undefined
        ? "created"
        : outcome.changed ? "updated" : "unchanged";
    const showDiff = existingBytes !== undefined && outcome.changed;
    return {
      ...base,
      status,
      hash: outcome.newHash,
      bytes: Buffer.byteLength(plan.content, "utf8"),
      ...(opts.dryRun ? { content: plan.content } : {}),
      ...(showDiff ? { diff: outcome.diff } : {}),
    };
  }
}

// ────────────────────────────── 生成内容 ──────────────────────────────

/**
 * 语言环境无关的最小 project.godot:config_version=5 头 + [application] + [rendering]。
 * 键值不带多余空格,段与段之间空一行 —— 与 Godot 4 自己写出的格式一致。
 */
function projectGodotText(o: { name: string; mainScene: string; renderer: RendererMethod }): string {
  return [
    "; Engine configuration file.",
    "; It's best edited using the editor UI and not directly,",
    "; since the parameters that go here are not all obvious.",
    ";",
    "; Format:",
    ";   [section] ; section goes between []",
    ";   key=value ; assign values to keys",
    "",
    "config_version=5",
    "",
    "[application]",
    "",
    `config/name="${o.name}"`,
    `run/main_scene="${o.mainScene}"`,
    "",
    "[rendering]",
    "",
    `renderer/rendering_method="${o.renderer}"`,
    "",
  ].join("\n");
}

/** 最小 [gd_scene format=3] 骨架(只有根节点),后续节点交给 scene_* 工具。 */
const MAIN_SCENE_TEXT = [
  "[gd_scene format=3]",
  "",
  '[node name="Main" type="Node2D"]',
  "",
].join("\n");

const GITIGNORE_TEXT = [
  "# Godot 4+ engine cache (regenerated on every import)",
  ".godot/",
  "",
  "# vino-godot-mcp: ClassDB API dump cache and Editor Bridge descriptor",
  ".vino-godot-mcp/",
  "",
].join("\n");

// ────────────────────────────── 入参校验 ──────────────────────────────

/**
 * projectPath 必须是显式绝对路径:本工具的语义是"在指定位置建工程",任何 cwd 回落都会让
 * 调用方在没意识到的情况下把文件写到 MCP 进程的启动目录里。
 */
function assertProjectRoot(projectPath: unknown): string {
  if (typeof projectPath !== "string" || projectPath.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", "projectPath is required: absolute path of the project root to create", {
      projectPath: projectPath ?? null,
    });
  }
  const raw = projectPath.trim();
  if (!path.isAbsolute(raw)) {
    throw new GodotMcpError(
      "INVALID_ARGUMENT",
      `projectPath must be an absolute path: ${raw}. This tool never falls back to the MCP process cwd.`,
      { projectPath: raw, reason: "not-absolute" },
    );
  }
  const root = path.resolve(raw);
  if (path.dirname(root) === root) {
    throw new GodotMcpError(
      "INVALID_ARGUMENT",
      `Refusing to initialise a Godot project at a filesystem root: ${root}`,
      { projectPath: root, reason: "filesystem-root" },
    );
  }
  const stat = statOrUndefined(root);
  if (stat && !stat.isDirectory()) {
    throw new GodotMcpError("INVALID_ARGUMENT", `projectPath exists but is not a directory: ${root}`, {
      projectPath: root, reason: "not-a-directory",
    });
  }
  return root;
}

/** projectName 会被写成 Godot 字符串字面量,因此拒绝引号/反斜杠/换行(不做转义魔法)。 */
function assertProjectName(projectName: unknown): string {
  if (typeof projectName !== "string") {
    throw new GodotMcpError("INVALID_ARGUMENT", "projectName is required", { projectName: projectName ?? null });
  }
  const name = projectName.trim();
  if (name === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", "projectName must not be empty", { projectName });
  }
  if (/["\\\r\n\0]/.test(name)) {
    throw new GodotMcpError(
      "INVALID_ARGUMENT",
      "projectName must not contain double quotes, backslashes or line breaks (it is written as a Godot string literal)",
      { projectName },
    );
  }
  return name;
}

function assertRenderer(renderer: unknown): RendererMethod {
  if (renderer === undefined) return DEFAULT_RENDERER;
  if (typeof renderer !== "string" || !(RENDERER_METHODS as readonly string[]).includes(renderer)) {
    throw new GodotMcpError(
      "INVALID_ARGUMENT",
      `renderer must be one of ${RENDERER_METHODS.join(", ")}: ${String(renderer)}`,
      { renderer, allowed: [...RENDERER_METHODS] },
    );
  }
  return renderer as RendererMethod;
}

// ────────────────────────────── 文件系统小工具 ──────────────────────────────

function statOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function isDirectory(p: string): boolean {
  return statOrUndefined(p)?.isDirectory() === true;
}

function isFile(p: string): boolean {
  return statOrUndefined(p)?.isFile() === true;
}

/** 目标为普通文件时返回其字节,否则 undefined(目录/设备/不存在)。 */
function readIfFile(p: string): Buffer | undefined {
  return isFile(p) ? fs.readFileSync(p) : undefined;
}

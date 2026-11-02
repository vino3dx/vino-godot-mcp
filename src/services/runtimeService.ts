// RuntimeService:通过 Godot CLI 启动项目/运行场景/导出构建的封装。
//
// 职责边界(单向依赖):定位可执行文件(GodotCliService.locate)→ 解析项目根(ProjectResolver)
// → 纯函数拼参数(godot/runtime/run.ts)→ 在项目级互斥队列内 spawn(不污染本进程 stdout)。
// 错误一律 throw GodotMcpError,由 ToolHost 统一成错误信封。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import { TaskQueue } from "../core/concurrency/taskQueue.js";
import { ProjectResolver } from "../core/project/projectResolver.js";
import type { GodotSource } from "../godot/cli.js";
import {
  buildExportArgs,
  buildRunArgs,
  defaultRunRunner,
  type GodotRunRunner,
  type RunProcessResult,
} from "../godot/runtime/run.js";
import {
  buildScreenshotArgs,
  DEFAULT_WAIT_FRAMES,
  isPng,
  parseRenderSize,
  readPngSize,
  SCREENSHOT_SCRIPT,
} from "../godot/runtime/screenshot.js";
import {
  buildInspectUiArgs,
  computeUiIssues,
  DEFAULT_INSPECT_FRAMES,
  DEFAULT_MAX_INSPECT_NODES,
  INSPECT_UI_SCRIPT,
  isUiInspectPayload,
  MAX_INSPECT_FRAMES,
  summarizeUiIssues,
  type InspectedControl,
  type UiIssueSummary,
  type UiIssueType,
} from "../godot/runtime/inspectUi.js";
import {
  buildCheckAddonStatusArgs,
  CHECK_ADDON_STATUS_SCRIPT,
  computeDiagnosis,
  isAddonStatusPayload,
  isPlatformMatch,
  MAX_ADDON_CHECK_CLASSES,
  parseEnabledPluginPaths,
  parseExtensionList,
  parseGdextension,
  parsePluginCfg,
  type AddonClassInfo,
  type AddonEngine,
  type AddonExtensionInfo,
  type AddonPluginInfo,
  type AddonStatusResult,
  type GdextensionLibraryInfo,
} from "../godot/runtime/checkAddonStatus.js";
import { MCP_RESULT_PREFIX, parseMcpResultJson, withTempScript } from "../godot/runtime/scriptRunner.js";
import type { GodotCliService } from "./godotCli.js";

/** 冷启动 + 首帧 + 退出,实测未测;取宽,由工具参数 timeoutMs 覆盖。 */
export const DEFAULT_RUN_TIMEOUT_MS = 30_000;

/** 截图内联为 image 内容块的上限(1MB);超过只返回路径。 */
export const MAX_IMAGE_BYTES = 1024 * 1024;

export interface RuntimeServiceOptions {
  godot: GodotCliService;
  project: ProjectResolver;
  runQueue: TaskQueue;
  /** 进程执行器(默认真实 spawn)。测试可注入替身。 */
  runner?: GodotRunRunner;
}

export interface RunProjectOptions {
  projectPath?: string;
  /** 要运行的场景;缺省用项目 main scene。 */
  scene?: string;
  headless?: boolean;
  quit?: boolean;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  extraArgs?: readonly string[];
  /** 锁持有者标识(工具名),写进 utility_task_status 的持有者。 */
  tool: string;
}

export interface ExportProjectOptions {
  projectPath?: string;
  preset: string;
  mode?: "release" | "debug";
  /** 输出文件路径(必填,含二进制文件名)。 */
  outputPath: string;
  headless?: boolean;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  extraArgs?: readonly string[];
  tool: string;
}

export interface CaptureScreenshotOptions {
  projectPath?: string;
  /** 要截图的场景;缺省用项目 main scene(脚本读 application/run/main_scene)。 */
  scene?: string;
  /** 输出缩放宽;缺省不缩放(保持渲染分辨率)。与 outputHeight 需成对。 */
  outputWidth?: number;
  outputHeight?: number;
  /** 截图前等待渲染的帧数;缺省 DEFAULT_WAIT_FRAMES。 */
  waitFrames?: number;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  /** 是否把 PNG 内联为 base64(文件 ≤1MB 时)。 */
  includeImage?: boolean;
  tool: string;
}

export interface CaptureScreenshotResult {
  /** 截图文件绝对路径(系统临时目录下 vino-godot-mcp/screenshots/)。 */
  filePath: string;
  /** 实际渲染尺寸(工程 viewport 设置,脚本经 stdout 回传)。 */
  renderSize: { width: number; height: number };
  /** 输出 PNG 尺寸(可能已被 outputWidth/outputHeight 缩放)。 */
  outputSize: { width: number; height: number };
  /** 文件字节数。 */
  fileSize: number;
  durationMs: number;
  command: string;
  resolvedPath: string;
  source: GodotSource;
  projectDir: string;
  /** includeImage=true 且文件 ≤1MB 时返回;否则 undefined。 */
  imageBase64?: string;
}

export interface InspectUiOptions {
  projectPath?: string;
  /** 要探测的场景(res:// 或项目相对路径);必填。 */
  scene: string;
  /** 只探测这些节点(相对场景根);不传则遍历全部 Control。 */
  nodePaths?: readonly string[];
  /** 等待布局稳定的帧数;缺省 DEFAULT_INSPECT_FRAMES,上限 MAX_INSPECT_FRAMES。 */
  frames?: number;
  /** 覆盖视口宽/高(必须成对);缺省用工程 display/window/size/viewport_* 设置。 */
  width?: number;
  height?: number;
  /** 是否也返回 not visible_in_tree 的 Control;缺省 false。 */
  includeHidden?: boolean;
  /** 返回节点数上限;缺省 DEFAULT_MAX_INSPECT_NODES,超出截断并置 truncated。 */
  maxNodes?: number;
  timeoutMs?: number;
  waitTimeoutMs?: number;
  tool: string;
}

/** 单个 Control 的探测结果 = 引擎快照 + 由 computeUiIssues 判定的布局问题。 */
export interface InspectedUiNode extends InspectedControl {
  issues: UiIssueType[];
}

export interface InspectUiResult {
  scene: string;
  viewportSize: { width: number; height: number };
  /** 命中的 Control 总数(截断前)。 */
  nodeCount: number;
  truncated: boolean;
  nodes: InspectedUiNode[];
  /** 请求了但没能解析成 Control 的 nodePaths。 */
  missing: string[];
  /** 各 issue 类型的命中节点数(只统计返回出去的节点)。 */
  summary: UiIssueSummary;
  engineVersion: string;
  durationMs: number;
  /** 展示用命令串(不用于执行)。 */
  command: string;
  resolvedPath: string;
  source: GodotSource;
  projectDir: string;
}

export interface CheckAddonStatusOptions {
  projectPath?: string;
  /** 要检查是否在 ClassDB 中注册的类名;最多 MAX_ADDON_CHECK_CLASSES 个。 */
  classes?: readonly string[];
  timeoutMs?: number;
  waitTimeoutMs?: number;
  tool: string;
}

/** 引擎 stderr 摘要上限(扩展加载失败会打印多行 ERROR,截断后仍足以定位)。 */
export const MAX_ENGINE_STDERR_SUMMARY = 4000;

/** 返回给工具层的归一化运行结果。 */
export interface RuntimeRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  /** 展示用命令串(不用于执行)。 */
  command: string;
  resolvedPath: string;
  source: GodotSource;
  projectDir: string;
}

export class RuntimeService {
  constructor(private readonly opts: RuntimeServiceOptions) {}

  /** 运行项目(或指定场景),headless + --quit 默认开启,作为冒烟测试返回日志。 */
  async runProject(o: RunProjectOptions): Promise<RuntimeRunResult> {
    const { path: file, source } = this.locate();
    const projectDir = this.projectDir(o.projectPath);
    const args = buildRunArgs(projectDir, {
      headless: o.headless ?? true,
      quit: o.quit ?? true,
      scene: o.scene,
      extraArgs: o.extraArgs,
    });
    return this.execute(file, source, projectDir, args, {
      timeoutMs: o.timeoutMs,
      waitTimeoutMs: o.waitTimeoutMs,
      tool: o.tool,
      target: o.scene ?? projectDir,
    });
  }

  /** 用预设导出/构建(export_presets.cfg 里的 preset 名)。 */
  async exportProject(o: ExportProjectOptions): Promise<RuntimeRunResult> {
    const { path: file, source } = this.locate();
    const projectDir = this.projectDir(o.projectPath);
    const args = buildExportArgs(projectDir, {
      preset: o.preset,
      mode: o.mode ?? "release",
      outputPath: o.outputPath,
      headless: o.headless ?? true,
      extraArgs: o.extraArgs,
    });
    return this.execute(file, source, projectDir, args, {
      timeoutMs: o.timeoutMs,
      waitTimeoutMs: o.waitTimeoutMs,
      tool: o.tool,
      target: o.preset,
    });
  }

  /**
   * 截图指定场景(非 headless):写临时 GDScript → --script 运行 → 校验 PNG → 返回元数据。
   * 截图渲染分辨率由工程 viewport 设置决定;outputWidth/outputHeight 仅缩放输出图。
   */
  async captureScreenshot(o: CaptureScreenshotOptions): Promise<CaptureScreenshotResult> {
    const { path: file, source } = this.locate();
    const projectDir = this.projectDir(o.projectPath);
    const waitFrames = o.waitFrames ?? DEFAULT_WAIT_FRAMES;
    const screenshotDir = path.join(os.tmpdir(), "vino-godot-mcp", "screenshots");
    const outPath = path.join(screenshotDir, `shot-${randomUUID()}.png`);
    fs.mkdirSync(screenshotDir, { recursive: true });
    let res: RuntimeRunResult;
    try {
      res = await withTempScript(
        SCREENSHOT_SCRIPT,
        (scriptPath) =>
          this.execute(
            file, source, projectDir,
            buildScreenshotArgs(projectDir, {
              scriptPath,
              outPath,
              scene: o.scene,
              waitFrames,
              outputWidth: o.outputWidth,
              outputHeight: o.outputHeight,
            }),
            { timeoutMs: o.timeoutMs, waitTimeoutMs: o.waitTimeoutMs, tool: o.tool, target: o.scene ?? "screenshot" },
          ),
        { prefix: "capture" },
      );
    } catch (e) {
      // 脚本对场景 load 失败显式 quit(2),映射为 FILE_NOT_FOUND(场景不存在)。
      if (e instanceof GodotMcpError && e.code === "GODOT_PROCESS_FAILED" && e.details?.["exitCode"] === 2) {
        throw new GodotMcpError("FILE_NOT_FOUND", `Scene not found: ${o.scene ?? "(main scene)"}`, {
          scene: o.scene ?? null,
          resolvedPath: e.details?.["resolvedPath"],
          stderr: e.details?.["stderr"],
        });
      }
      throw e;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(outPath);
    } catch {
      throw new GodotMcpError(
        "RUNTIME_FAILED",
        "Godot exited successfully but no screenshot file was created",
        { filePath: outPath, stdout: res.stdout, stderr: res.stderr },
      );
    }
    if (!isPng(buf)) {
      throw new GodotMcpError("RUNTIME_FAILED", "Screenshot file is not a valid PNG", {
        filePath: outPath, fileSize: buf.length, stdout: res.stdout, stderr: res.stderr,
      });
    }
    const outputSize = readPngSize(buf);
    // 渲染尺寸以脚本回传为准;未回传时回退为输出尺寸(未缩放时两者本就相等)。
    const renderSize = parseRenderSize(res.stdout) ?? outputSize;
    const result: CaptureScreenshotResult = {
      filePath: outPath,
      renderSize,
      outputSize,
      fileSize: buf.length,
      durationMs: res.durationMs,
      command: res.command,
      resolvedPath: res.resolvedPath,
      source: res.source,
      projectDir: res.projectDir,
    };
    if (o.includeImage && buf.length <= MAX_IMAGE_BYTES) {
      result.imageBase64 = buf.toString("base64");
    }
    return result;
  }

  /**
   * 运行时 UI 布局探针(**非 headless**):临时 GDScript 加载场景 → 等 frames 帧 → 采集每个 Control
   * 的真实矩形/最小尺寸/父级关系 → 单行 MCP_RESULT_JSON 回传 → 这里补算 issues 与 summary。
   *
   * 严格只读:不保存场景、不写任何项目文件、不调用 ResourceSaver;但会执行场景内脚本(_ready/_process)。
   * 非 headless 的硬性理由见 godot/runtime/inspectUi.ts 顶部实测结论(headless 视口恒 64x64,布局会被压扁)。
   */
  async inspectUi(o: InspectUiOptions): Promise<InspectUiResult> {
    const { path: file, source } = this.locate();
    const projectDir = this.projectDir(o.projectPath);
    const frames = clampInt(o.frames ?? DEFAULT_INSPECT_FRAMES, 1, MAX_INSPECT_FRAMES);
    const maxNodes = Math.max(1, o.maxNodes ?? DEFAULT_MAX_INSPECT_NODES);
    let res: RuntimeRunResult;
    try {
      res = await withTempScript(
        INSPECT_UI_SCRIPT,
        (scriptPath) =>
          this.execute(
            file, source, projectDir,
            buildInspectUiArgs(projectDir, {
              scriptPath,
              scene: o.scene,
              nodePaths: o.nodePaths ?? [],
              frames,
              ...(o.width !== undefined ? { width: o.width } : {}),
              ...(o.height !== undefined ? { height: o.height } : {}),
              includeHidden: o.includeHidden ?? false,
              maxNodes,
            }),
            { timeoutMs: o.timeoutMs, waitTimeoutMs: o.waitTimeoutMs, tool: o.tool, target: o.scene },
          ),
        { prefix: "inspect-ui" },
      );
    } catch (e) {
      // 脚本对场景 load 失败显式 quit(2),映射为 FILE_NOT_FOUND(场景不存在)。
      if (e instanceof GodotMcpError && e.code === "GODOT_PROCESS_FAILED" && e.details?.["exitCode"] === 2) {
        throw new GodotMcpError("FILE_NOT_FOUND", `Scene not found: ${o.scene}`, {
          scene: o.scene,
          resolvedPath: e.details?.["resolvedPath"],
          stderr: e.details?.["stderr"],
        });
      }
      throw e;
    }
    const parsed = parseMcpResultJson(res.stdout);
    if (!parsed.ok) {
      throw new GodotMcpError("RUNTIME_FAILED", `Engine did not print a ${MCP_RESULT_PREFIX}<json> line`, {
        scene: o.scene, reason: parsed.reason, detail: parsed.message, stdout: res.stdout, stderr: res.stderr,
      });
    }
    if (!isUiInspectPayload(parsed.value)) {
      throw new GodotMcpError("RUNTIME_FAILED", "Engine returned an unexpected layout result shape", {
        scene: o.scene, stdout: res.stdout, stderr: res.stderr,
      });
    }
    const payload = parsed.value;
    const nodes: InspectedUiNode[] = payload.nodes.map((n) => ({
      ...n,
      issues: computeUiIssues(n, payload.viewportSize),
    }));
    return {
      scene: payload.scene,
      viewportSize: payload.viewportSize,
      nodeCount: payload.nodeCount,
      truncated: payload.truncated,
      nodes,
      missing: payload.missing,
      summary: summarizeUiIssues(nodes),
      engineVersion: payload.engineVersion,
      durationMs: res.durationMs,
      command: res.command,
      resolvedPath: res.resolvedPath,
      source: res.source,
      projectDir: res.projectDir,
    };
  }

  /**
   * 插件 / GDExtension 注册状态探针:静态扫描(.gdextension、.godot/extension_list.cfg、已启用插件)
   * + 一次 headless `--script` 引擎探针(loaded extensions / ClassDB 注册 / 引擎版本),最后汇总 diagnosis。
   *
   * 静态部分不依赖引擎:找不到 Godot、超时、非零退出、回传形状不对时**仍然返回**,
   * 此时 engine = {ok:false, error:{code,message}},而 extensions[].loaded 与 classes 为 null
   * (= 未知,不是 false / "不存在");diagnosis 里也不再给 extension_not_loaded / class_missing。
   *
   * 只读:不保存场景、不写任何项目文件;但 `--script` 会初始化项目并**执行 autoload**(4.6.3 实测),
   * 所以工具层 annotations.readOnly 标为 false。
   */
  async checkAddonStatus(o: CheckAddonStatusOptions): Promise<AddonStatusResult> {
    const startedAt = Date.now();
    const projectDir = this.projectDir(o.projectPath);
    const requested = o.classes ?? [];
    if (requested.length > MAX_ADDON_CHECK_CLASSES) {
      throw new GodotMcpError(
        "INVALID_ARGUMENT",
        `classes must contain at most ${MAX_ADDON_CHECK_CLASSES} entries`,
        { count: requested.length, max: MAX_ADDON_CHECK_CLASSES },
      );
    }

    // 静态扫描放在引擎运行之前:报告应反映"进来时"的工程,而不是引擎跑完可能补出的 .godot 缓存。
    const listed = this.readExtensionList(projectDir);
    const extensions = this.scanGdextensions(projectDir, listed === null ? null : new Set(listed));
    const plugins = this.scanEnabledPlugins(projectDir);

    let engine: AddonEngine;
    let loadedExtensions: string[] | null = null;
    let classResults: Record<string, AddonClassInfo> | null = null;
    try {
      const { path: file, source } = this.locate();
      const res = await withTempScript(
        CHECK_ADDON_STATUS_SCRIPT,
        (scriptPath) =>
          this.execute(
            file, source, projectDir,
            buildCheckAddonStatusArgs(projectDir, scriptPath, requested),
            { timeoutMs: o.timeoutMs, waitTimeoutMs: o.waitTimeoutMs, tool: o.tool, target: "addon-status" },
          ),
        { prefix: "addon-status" },
      );
      const parsed = parseMcpResultJson(res.stdout);
      if (!parsed.ok) {
        throw new GodotMcpError("RUNTIME_FAILED", `Engine did not print a ${MCP_RESULT_PREFIX}<json> line`, {
          reason: parsed.reason, detail: parsed.message, stdout: res.stdout, stderr: res.stderr,
        });
      }
      if (!isAddonStatusPayload(parsed.value)) {
        throw new GodotMcpError("RUNTIME_FAILED", "Engine returned an unexpected addon-status shape", {
          stdout: res.stdout, stderr: res.stderr,
        });
      }
      const payload = parsed.value;
      loadedExtensions = payload.loadedExtensions;
      classResults = payload.classes;
      const summary = summarizeStderr(res.stderr);
      engine = summary === undefined
        ? { ok: true, version: payload.engineVersion }
        : { ok: true, version: payload.engineVersion, stderr: summary };
    } catch (e) {
      const err = e instanceof GodotMcpError
        ? e
        : new GodotMcpError("RUNTIME_FAILED", e instanceof Error ? e.message : String(e));
      engine = { ok: false, error: { code: err.code, message: err.message } };
    }

    const loadedSet = loadedExtensions === null ? null : new Set(loadedExtensions);
    const extensionsWithLoaded: AddonExtensionInfo[] = extensions.map((ext) => ({
      ...ext,
      loaded: loadedSet === null ? null : loadedSet.has(ext.path),
    }));

    return {
      engine,
      extensionListFound: listed !== null,
      extensions: extensionsWithLoaded,
      classes: classResults,
      plugins,
      diagnosis: computeDiagnosis({
        extensionListFound: listed !== null,
        extensions: extensionsWithLoaded,
        loadedExtensions,
        requestedClasses: requested,
        classResults,
        plugins,
      }),
      durationMs: Date.now() - startedAt,
    };
  }

  /** 读 .godot/extension_list.cfg;不存在(或读不动)返回 null。 */
  private readExtensionList(projectDir: string): string[] | null {
    try {
      return parseExtensionList(fs.readFileSync(path.join(projectDir, ".godot", "extension_list.cfg"), "utf8"));
    } catch {
      return null;
    }
  }

  /** 扫描工程内所有 *.gdextension,按 res:// 路径升序返回(排序保证 diagnosis 与返回顺序稳定)。 */
  private scanGdextensions(projectDir: string, listed: ReadonlySet<string> | null): AddonExtensionInfo[] {
    return collectFilesWithExtension(projectDir, ".gdextension")
      .map((file) => {
        const resPath = toResPath(projectDir, file);
        let parsed: { entrySymbol?: string; compatibilityMinimum?: string; libraries: { key: string; path: string }[] } = { libraries: [] };
        try {
          parsed = parseGdextension(fs.readFileSync(file, "utf8"));
        } catch {
          // 单个 .gdextension 解析失败不拖垮整份诊断:按"没有可读库"处理
          // (约定结构里没有逐扩展的错误字段;此限制已写入报告)。
        }
        const libraries: GdextensionLibraryInfo[] = parsed.libraries.map((l) => ({
          key: l.key,
          path: l.path,
          exists: fs.existsSync(resolveProjectPath(projectDir, l.path)),
          platformMatch: isPlatformMatch(l.key, process.platform),
        }));
        const info: AddonExtensionInfo = {
          path: resPath,
          loaded: null,
          listedInExtensionList: listed?.has(resPath) ?? false,
          libraries,
        };
        if (parsed.entrySymbol !== undefined) info.entrySymbol = parsed.entrySymbol;
        if (parsed.compatibilityMinimum !== undefined) info.compatibilityMinimum = parsed.compatibilityMinimum;
        return info;
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 读 project.godot 的 [editor_plugins] enabled,逐个检查 plugin.cfg 及其 script 是否存在。
   * 只报告"已启用 + 文件齐全",**不声称插件已加载**(加载与否要问引擎,不在这一层)。
   */
  private scanEnabledPlugins(projectDir: string): AddonPluginInfo[] {
    let projectText: string;
    try {
      projectText = fs.readFileSync(path.join(projectDir, "project.godot"), "utf8");
    } catch {
      return [];
    }
    return parseEnabledPluginPaths(projectText).map((pluginPath) => {
      const abs = resolveProjectPath(projectDir, pluginPath);
      const cfgExists = fs.existsSync(abs);
      const info: AddonPluginInfo = { path: pluginPath, cfgExists, scriptExists: false };
      if (!cfgExists) return info;
      let cfg: { name?: string; script?: string };
      try {
        cfg = parsePluginCfg(fs.readFileSync(abs, "utf8"));
      } catch {
        return info;
      }
      if (cfg.name !== undefined) info.name = cfg.name;
      if (cfg.script !== undefined) {
        info.script = cfg.script;
        info.scriptExists = fs.existsSync(resolvePluginScript(projectDir, abs, cfg.script));
      }
      return info;
    });
  }

  private locate(): { path: string; source: GodotSource } {
    return this.opts.godot.locate();
  }

  private projectDir(projectPath?: string): string {
    return this.opts.project.resolve(projectPath);
  }

  private async execute(
    file: string,
    source: GodotSource,
    projectDir: string,
    args: string[],
    o: { timeoutMs?: number; waitTimeoutMs?: number; tool: string; target: string },
  ): Promise<RuntimeRunResult> {
    const timeoutMs = o.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const runner = this.opts.runner ?? defaultRunRunner;
    let res: RunProcessResult;
    try {
      res = await this.opts.runQueue.runExclusive(
        projectDir,
        { tool: o.tool, target: o.target },
        (signal) => runner(file, args, { timeoutMs, signal }),
        { ...(o.waitTimeoutMs !== undefined ? { waitTimeoutMs: o.waitTimeoutMs } : {}) },
      );
    } catch (e) {
      throw mapRunError(e, file);
    }
    const command = [file, ...args].join(" ");
    const logs = {
      stdout: res.stdout,
      stderr: res.stderr,
      stdoutTruncated: res.stdoutTruncated,
      stderrTruncated: res.stderrTruncated,
      durationMs: res.durationMs,
    };
    if (res.timedOut) {
      throw new GodotMcpError("TASK_TIMEOUT", `Godot did not exit within ${timeoutMs}ms and was killed`, {
        timeoutMs, resolvedPath: file, source, command, ...logs,
      });
    }
    if (res.exitCode !== null && res.exitCode !== 0) {
      throw new GodotMcpError("GODOT_PROCESS_FAILED", `Godot exited with code ${res.exitCode}`, {
        exitCode: res.exitCode, resolvedPath: file, source, command, ...logs,
      });
    }
    if (res.exitCode === null && res.signal !== null) {
      throw new GodotMcpError("GODOT_PROCESS_FAILED", `Godot was terminated by signal ${res.signal}`, {
        signal: res.signal, resolvedPath: file, source, command, ...logs,
      });
    }
    return { ...res, command, resolvedPath: file, source, projectDir };
  }
}

/** 把数值夹到 [min, max](工具层已按 schema 校验,这里是服务层的兜底)。 */
function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** spawn 阶段的错误 → 统一错误码:ENOENT 归 GODOT_NOT_FOUND,其余归 GODOT_PROCESS_FAILED。 */
function mapRunError(e: unknown, file: string): never {
  if (e instanceof GodotMcpError) throw e; // 例如队列等待超时 LOCK_TIMEOUT,原样透传
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") {
    throw new GodotMcpError("GODOT_NOT_FOUND", `Godot executable disappeared before spawn: ${file}`, {
      resolvedPath: file, reason: "ENOENT",
    });
  }
  throw new GodotMcpError("GODOT_PROCESS_FAILED", `Failed to spawn Godot: ${file}`, {
    resolvedPath: file, reason: typeof err?.code === "string" ? err.code : String(e),
  });
}

// ────────────────────── runtime_check_addon_status 的静态扫描辅助 ──────────────────────

/**
 * 递归收集扩展名匹配的文件绝对路径。**跳过以 `.` 开头的目录**(`.godot` 缓存、`.git` 等):
 * 与引擎把 res:// 资源树排除点目录的口径一致,也保证不会去扫 .godot 里的扩展清单副本。
 */
function collectFilesWithExtension(dir: string, extension: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return; // 无权限/中途消失:跳过该目录,不拖垮整份诊断
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(extension)) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** 工程内绝对路径 → res:// 路径(统一正斜杠)。 */
function toResPath(projectDir: string, absPath: string): string {
  return "res://" + path.relative(projectDir, absPath).split(path.sep).join("/");
}

/** res:// 或工程相对路径 → 工程内绝对路径;已是绝对路径则原样返回。 */
function resolveProjectPath(projectDir: string, p: string): string {
  if (p.startsWith("res://")) return path.join(projectDir, p.slice("res://".length));
  return path.isAbsolute(p) ? p : path.join(projectDir, p);
}

/** plugin.cfg 的 script 字段 → 绝对路径(res:// 按工程根,其余相对 plugin.cfg 所在目录)。 */
function resolvePluginScript(projectDir: string, pluginCfgPath: string, script: string): string {
  return script.startsWith("res://")
    ? resolveProjectPath(projectDir, script)
    : path.join(path.dirname(pluginCfgPath), script);
}

/** 引擎 stderr 的非空摘要;干净时返回 undefined(不产出空的 stderr 字段)。 */
function summarizeStderr(stderr: string): string | undefined {
  const text = stderr.trim();
  if (text === "") return undefined;
  return text.length > MAX_ENGINE_STDERR_SUMMARY
    ? `${text.slice(0, MAX_ENGINE_STDERR_SUMMARY)}…(truncated)`
    : text;
}

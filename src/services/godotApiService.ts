// GodotApiService:ClassDB 类元数据的唯一入口(供 scene_get_node_info 这类"需要权威类信息"的读侧工具)。
//
// 数据来源:引擎自己导出的 `extension_api.json`(`godot --headless --dump-extension-api`)。
// 关键设计 —— **不在每次调用时启动引擎**:
//   1. 产物按引擎版本缓存到 `<被操作工程根>/.vino-godot-mcp/extension-api/<版本>.json`
//      (该目录已在本仓 .gitignore,也会由 README 提示用户忽略);
//   2. 进程内再缓存"解析后的精简索引"(丢弃方法体,只留类/属性/信号/枚举);
//   3. 缓存键取 `godot --version` 的**完整原文**(如 4.6.3.stable.official.7d41c59c4)——
//      src/godot/cli.ts 解析出的版本号只有 4.6.3,不足以区分同版本的 stable/beta 产物。
//
// 降级:引擎不可用时**明确报错**(GODOT_NOT_FOUND / GODOT_PROCESS_FAILED + 原因与 GODOT_PATH),
// 不返回空表、不内置 ClassDB 快照、不猜。写侧工具(如 scene_update_node_property)不依赖本服务。
import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import { TaskCancelledError, throwIfAborted } from "../core/concurrency/cancellation.js";
import type { TaskQueue } from "../core/concurrency/taskQueue.js";
import type { ProjectResolver } from "../core/project/projectResolver.js";
import {
  buildDumpExtensionApiArgs,
  cacheKeyOf,
  EXTENSION_API_FILE,
  parseExtensionApi,
  type ApiEnum,
  type ApiMethod,
  type ApiSignal,
  type ExtensionApi,
} from "../godot/api/extensionApi.js";
import { defaultRunRunner, type GodotRunRunner, type RunProcessResult } from "../godot/runtime/run.js";
import type { GodotCliService } from "./godotCli.js";

/** 缓存目录(工程根下)。 */
export const API_CACHE_DIR = ".vino-godot-mcp";
/** 缓存子目录(按工具领域分组,便于以后放别的缓存)。 */
export const API_CACHE_SUBDIR = "extension-api";

/** dump 的引擎超时:冷启动 + 写 ~6.5MB,取值从宽(与真实测试同量级)。 */
export const DUMP_TIMEOUT_MS = 60_000;

export interface GodotApiServiceOptions {
  godot: GodotCliService;
  project: ProjectResolver;
  /** 与 runtime 工具共用同一把项目级锁,避免同时起两个 Godot 进程。 */
  runQueue: TaskQueue;
  /** 进程执行器(默认真实 spawn);测试可注入替身。 */
  runner?: GodotRunRunner;
  timeoutMs?: number;
  /** 环境变量来源(默认 process.env);仅用于把 GODOT_PATH 写进错误细节。 */
  env?: NodeJS.ProcessEnv;
}

/** 属性 + 已解析的枚举(枚举取自本类/全局枚举表,关联来自 setter 参数类型)。 */
export interface ClassInfoProperty {
  name: string;
  type: string;
  enum?: ApiEnum;
  getter?: string;
  setter?: string;
  declaredBy?: string;
  inherited?: boolean;
}

export interface ClassInfoMethod extends ApiMethod { declaredBy?: string; inherited?: boolean }

/** 字面量类别(只用于"明显不匹配"的粗判定,不做完整类型系统)。 */
export type LiteralKind =
  | "boolean" | "number" | "string" | "vector2" | "vector2i" | "vector3" | "vector3i"
  | "color" | "rect2" | "nodepath" | "resource" | "array" | "dictionary" | "null" | "unknown";

export interface NodePropertyCheck {
  name: string;
  status: "verified" | "unknown" | "type_mismatch" | "dynamic";
  declaredBy?: string;
  inherited?: boolean;
  expectedType?: string;
  literalKind?: LiteralKind;
  reason?: string;
}

/**
 * `scene_connect_signal` 的信号存在性校验结果。
 * `unavailable` 必须原样回报,不能假装通过(也不能因此拦截写入 —— 引擎不可用时降级为警告)。
 */
export interface NodeSignalValidation {
  status: "verified" | "class_missing" | "not_a_node" | "unavailable";
  source: "classdb" | "none";
  nodeType: string;
  nodeTypeExists: boolean;
  /** 被校验的信号名。 */
  signal: string;
  /** 该类型(含继承链)是否声明了这个信号;status 非 verified 时为 false(不代表"不存在")。 */
  hasSignal: boolean;
  /** 声明该信号的类;hasSignal 为 true 时才出现。 */
  declaredBy?: string;
  /** 信号来自祖先类(而非 nodeType 自身)。 */
  inherited?: boolean;
  /** 名字相近的信号(拼写错误的提示),最多 5 个。 */
  suggestions?: string[];
  engineVersion?: string;
  apiVersionFullName?: string;
  reason?: string;
}

/** 写侧工具的 ClassDB 校验结果。`unavailable` 必须原样回报,不能假装通过。 */
export interface NodePropertyValidation {
  status: "verified" | "not_a_node" | "not_instantiable" | "class_missing" | "unavailable";
  source: "classdb" | "none";
  nodeType: string;
  nodeTypeExists: boolean;
  inheritsNode?: boolean;
  isInstantiable?: boolean;
  engineVersion?: string;
  apiVersionFullName?: string;
  properties: NodePropertyCheck[];
  warnings: string[];
  reason?: string;
}

export interface ClassInfo {
  nodeType: string;
  /** `core` | `editor`(dump 原文)。 */
  apiType: string;
  isInstantiable: boolean;
  /** 继承链:**父类 → Object**,不含自身;数据来自每个类的 inherits 字段。 */
  inheritance: string[];
  /** 该类自身声明的属性(未合并继承属性;需要继承的请按 inheritance 逐级取)。 */
  properties: ClassInfoProperty[];
  signals: ApiSignal[];
  methods?: ClassInfoMethod[];
  enums?: ApiEnum[];
  constants?: Array<{ name: string; value: number; declaredBy?: string; inherited?: boolean }>;
  allProperties?: ClassInfoProperty[];
  allMethods?: ClassInfoMethod[];
  allSignals?: Array<ApiSignal & { declaredBy?: string; inherited?: boolean }>;
  allEnums?: Array<ApiEnum & { declaredBy?: string; inherited?: boolean }>;
  source: {
    /** `godot --version` 原文(缓存键)。 */
    engineVersion: string;
    /** dump 的 header.version_full_name。 */
    apiVersionFullName?: string;
    /** 缓存文件绝对路径。 */
    cacheFile: string;
    /** 本次是否命中已有缓存(未启动引擎)。 */
    fromCache: boolean;
    verificationStatus: "engine_dump";
  };
}

interface LoadedApi {
  api: ExtensionApi;
  cacheFile: string;
  fromCache: boolean;
}

function collectMembers(api: ExtensionApi, className: string): { properties: ClassInfoProperty[]; methods: ClassInfoMethod[]; signals: Array<ApiSignal & { declaredBy?: string; inherited?: boolean }>; enums: Array<ApiEnum & { declaredBy?: string; inherited?: boolean }> } {
  const properties: ClassInfoProperty[] = []; const methods: ClassInfoMethod[] = []; const signals: Array<ApiSignal & { declaredBy?: string; inherited?: boolean }> = []; const enums: Array<ApiEnum & { declaredBy?: string; inherited?: boolean }> = []; const seen = new Set<string>(); let current: string | undefined = className;
  while (current && !seen.has(current)) { seen.add(current); const c = api.classes.get(current); if (!c) break; for (const p of c.properties) { if (!properties.some((x) => x.name === p.name)) properties.push({ name: p.name, type: p.type, ...(p.getter ? { getter: p.getter } : {}), ...(p.setter ? { setter: p.setter } : {}), declaredBy: current, inherited: current !== className }); } for (const m of c.methods) if (!methods.some((x) => x.name === m.name)) methods.push({ ...m, declaredBy: current, inherited: current !== className }); for (const s of c.signals) if (!signals.some((x) => x.name === s.name)) signals.push({ ...s, declaredBy: current, inherited: current !== className }); for (const e of c.enums) if (!enums.some((x) => x.name === e.name)) enums.push({ ...e, declaredBy: current, inherited: current !== className }); current = c.inherits; }
  return { properties, methods, signals, enums };
}

export class GodotApiService {
  /** 解析后的索引按缓存文件记忆;键含引擎版本,不会跨版本串味。 */
  private readonly memory = new Map<string, ExtensionApi>();
  private versionPromise?: Promise<string>;

  constructor(private readonly opts: GodotApiServiceOptions) {}

  /** 取一个类的 ClassDB 信息;类不存在抛 INVALID_ARGUMENT(不猜、不静默返回空表)。 */
  async getClassInfo(projectPath: string | undefined, nodeType: string, signal?: AbortSignal): Promise<ClassInfo> {
    const requested = typeof nodeType === "string" ? nodeType.trim() : "";
    if (requested === "") {
      throw new GodotMcpError("INVALID_ARGUMENT", "nodeType 不能为空(需要 Godot 类名,如 Node2D)", { param: "nodeType", nodeType });
    }
    const loaded = await this.load(this.opts.project.resolve(projectPath), signal);
    const cls = loaded.api.classes.get(requested);
    if (!cls) {
      throw new GodotMcpError("INVALID_ARGUMENT", `ClassDB 里没有这个类: ${JSON.stringify(nodeType)}`, {
        param: "nodeType",
        nodeType,
        knownClasses: loaded.api.classes.size,
        apiVersion: loaded.api.versionFullName ?? null,
      });
    }

    const properties = cls.properties.map((p) => {
      const resolved = p.enumName === undefined ? undefined : this.resolveEnum(loaded.api, p.enumName);
      return { name: p.name, type: p.type, ...(p.getter ? { getter: p.getter } : {}), ...(p.setter ? { setter: p.setter } : {}), ...(resolved ? { enum: resolved } : {}), declaredBy: cls.name, inherited: false };
    });
    const source: ClassInfo["source"] = {
      engineVersion: await this.engineVersion(),
      cacheFile: loaded.cacheFile,
      fromCache: loaded.fromCache,
      verificationStatus: "engine_dump",
    };
    if (loaded.api.versionFullName !== undefined) source.apiVersionFullName = loaded.api.versionFullName;

    const all = collectMembers(loaded.api, cls.name);
    return {
      nodeType: cls.name,
      apiType: cls.apiType,
      isInstantiable: cls.isInstantiable,
      inheritance: inheritanceOf(loaded.api, cls.name),
      properties,
      signals: cls.signals,
      methods: cls.methods.map((m) => ({ ...m, declaredBy: cls.name, inherited: false })),
      enums: cls.enums,
      constants: cls.constants.map((c) => ({ ...c, declaredBy: cls.name, inherited: false })),
      allProperties: all.properties,
      allMethods: all.methods,
      allSignals: all.signals,
      allEnums: all.enums,
      source,
    };
  }

  async searchClasses(projectPath: string | undefined, query: string, limit = 100, signal?: AbortSignal): Promise<{ name: string; inherits?: string; apiType: string; isInstantiable: boolean }[]> {
    const loaded = await this.load(this.opts.project.resolve(projectPath), signal); const q = query.trim().toLowerCase();
    return [...loaded.api.classes.values()].filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, Math.max(1, Math.min(limit, 500))).map((c) => ({ name: c.name, ...(c.inherits ? { inherits: c.inherits } : {}), apiType: c.apiType, isInstantiable: c.isInstantiable }));
  }

  async validateMember(projectPath: string | undefined, className: string, member: { property?: string; method?: string; signal?: string; enumMember?: string }): Promise<{ className: string; exists: boolean; member: typeof member; source: ClassInfo["source"] }> {
    const info = await this.getClassInfo(projectPath, className); const found = member.property ? info.allProperties?.some((p) => p.name === member.property) : member.method ? info.allMethods?.some((m) => m.name === member.method) : member.signal ? info.allSignals?.some((s) => s.name === member.signal) : false;
    return { className, exists: Boolean(found), member, source: info.source };
  }

  /**
   * 校验节点类型与一组属性的 ClassDB 归属,用于写侧工具(P1-A)。
   *
   * 语义:
   *   - 类不存在 / 非 Node 派生 / 不可实例化 → 由调用方决定是否拒绝(本方法如实回报)。
   *   - 属性不在继承链 → 记 warning(不静默通过)。
   *   - 字面量类型明显不符 → 记 warning。
   *   - ClassDB 不可用 → status="unavailable",不抛错(调用方必须把这个状态回报给用户)。
   *   - 无法可靠判断的属性(编辑器伪属性、theme_override、metadata 等)标为 "dynamic",不产生噪音 warning。
   */
  async validateNodeProperties(
    projectPath: string | undefined,
    nodeType: string,
    properties: ReadonlyArray<{ name: string; value: string }>,
  ): Promise<NodePropertyValidation> {
    const base: NodePropertyValidation = {
      status: "unavailable", source: "none", nodeType,
      nodeTypeExists: false, properties: [], warnings: [],
    };

    let info: ClassInfo;
    try {
      info = await this.getClassInfo(projectPath, nodeType);
    } catch (e) {
      if (e instanceof GodotMcpError && e.code === "INVALID_ARGUMENT" && e.details?.["param"] === "nodeType") {
        return {
          ...base,
          status: "class_missing",
          reason: e.message,
          warnings: [`Node type "${nodeType}" does not exist in ClassDB.`],
        };
      }
      if (e instanceof GodotMcpError && (e.code === "GODOT_NOT_FOUND" || e.code === "GODOT_PROCESS_FAILED" || e.code === "PARSE_ERROR")) {
        return { ...base, reason: `ClassDB validation is unavailable: ${e.message}` };
      }
      throw e;
    }

    const all = info.allProperties ?? info.properties;
    const inheritance = [info.nodeType, ...info.inheritance];
    const inheritsNode = inheritance.includes("Node");
    const status: NodePropertyValidation["status"] = !inheritsNode
      ? "not_a_node"
      : info.isInstantiable ? "verified" : "not_instantiable";

    const checked: NodePropertyCheck[] = [];
    const warnings: string[] = [];
    for (const property of properties) {
      if (isUnverifiableSceneProperty(property.name)) {
        checked.push({ name: property.name, status: "dynamic", reason: "editor/dynamic property, not a ClassDB member" });
        continue;
      }
      const declared = all.find((p) => p.name === property.name);
      if (!declared) {
        checked.push({ name: property.name, status: "unknown" });
        warnings.push(`Property "${property.name}" is not declared by "${info.nodeType}" or its ancestors.`);
        continue;
      }
      const kind = inferLiteralKind(property.value);
      const comparison = compareLiteralToType(declared, kind);
      if (comparison === "mismatch") {
        checked.push({
          name: property.name, status: "type_mismatch", declaredBy: declared.declaredBy,
          inherited: declared.inherited, expectedType: declared.type, literalKind: kind,
        });
        warnings.push(
          `Property "${property.name}" on "${info.nodeType}" expects ${declared.type}, but the value looks like ${kind}.`,
        );
        continue;
      }
      checked.push({
        name: property.name, status: "verified", declaredBy: declared.declaredBy,
        inherited: declared.inherited, expectedType: declared.type,
        ...(kind === "unknown" ? {} : { literalKind: kind }),
      });
    }

    return {
      status,
      source: "classdb",
      engineVersion: info.source.engineVersion,
      apiVersionFullName: info.source.apiVersionFullName,
      nodeType: info.nodeType,
      nodeTypeExists: true,
      inheritsNode,
      isInstantiable: info.isInstantiable,
      properties: checked,
      warnings,
    };
  }

  /**
   * 校验某个类(含继承链)是否声明了一个信号 —— `scene_connect_signal` 的 D3 校验。
   *
   * 语义(与 validateNodeProperties 一致,不猜):
   *   - 类不存在 → class_missing(调用方**不得**据此拦截:类型来自场景文件,可能是 GDExtension/插件类);
   *   - 类型不是 Node 派生 → not_a_node;
   *   - ClassDB 不可用 → unavailable(调用方降级为警告);
   *   - 其余为 verified:hasSignal 才是权威结论,可据此硬拦截拼错的信号名。
   */
  async validateNodeSignal(
    projectPath: string | undefined,
    nodeType: string,
    signalName: string,
  ): Promise<NodeSignalValidation> {
    const base: NodeSignalValidation = {
      status: "unavailable", source: "none", nodeType, nodeTypeExists: false, signal: signalName, hasSignal: false,
    };

    let info: ClassInfo;
    try {
      info = await this.getClassInfo(projectPath, nodeType);
    } catch (e) {
      if (e instanceof GodotMcpError && e.code === "INVALID_ARGUMENT" && e.details?.["param"] === "nodeType") {
        return { ...base, status: "class_missing", reason: e.message };
      }
      if (e instanceof GodotMcpError && (e.code === "GODOT_NOT_FOUND" || e.code === "GODOT_PROCESS_FAILED" || e.code === "PARSE_ERROR")) {
        return { ...base, reason: `ClassDB validation is unavailable: ${e.message}` };
      }
      throw e;
    }

    if (![info.nodeType, ...info.inheritance].includes("Node")) {
      return {
        ...base,
        status: "not_a_node",
        nodeTypeExists: true,
        reason: `"${info.nodeType}" is not a Node subclass, so it cannot be a scene signal source.`,
      };
    }

    const signals: Array<ApiSignal & { declaredBy?: string; inherited?: boolean }> = info.allSignals ?? info.signals;
    const declared = signals.find((s) => s.name === signalName);
    const result: NodeSignalValidation = {
      status: "verified",
      source: "classdb",
      nodeType: info.nodeType,
      nodeTypeExists: true,
      signal: signalName,
      hasSignal: declared !== undefined,
      engineVersion: info.source.engineVersion,
      ...(info.source.apiVersionFullName === undefined ? {} : { apiVersionFullName: info.source.apiVersionFullName }),
    };
    if (declared === undefined) {
      const suggestions = closestSignalNames(signals.map((s) => s.name), signalName);
      if (suggestions.length > 0) result.suggestions = suggestions;
      return result;
    }
    if (declared.declaredBy !== undefined) result.declaredBy = declared.declaredBy;
    result.inherited = declared.inherited === true;
    return result;
  }

  /** `<项目根>/.vino-godot-mcp/extension-api/<版本>.json`(对外暴露给测试与文档)。 */
  cacheFileFor(projectRoot: string, version: string): string {
    return path.join(projectRoot, API_CACHE_DIR, API_CACHE_SUBDIR, `${cacheKeyOf(version)}.json`);
  }

  // ────────────────────────────── 内部 ──────────────────────────────

  /** 命中内存/磁盘缓存就直接用;磁盘缓存损坏(解析失败)才删除并重新 dump。 */
  private async load(root: string, signal?: AbortSignal): Promise<LoadedApi> {
    throwIfAborted(signal, "classdb.dump", "queue");
    const cacheFile = this.cacheFileFor(root, await this.engineVersion());
    const hit = this.memory.get(cacheFile);
    if (hit) return { api: hit, cacheFile, fromCache: true };

    if (fs.existsSync(cacheFile)) {
      const cached = this.readCache(cacheFile);
      if (cached) {
        this.memory.set(cacheFile, cached);
        return { api: cached, cacheFile, fromCache: true };
      }
    }

    const api = await this.dump(root, path.dirname(cacheFile), cacheFile, signal);
    this.memory.set(cacheFile, api);
    return { api, cacheFile, fromCache: false };
  }

  /**
   * 读磁盘缓存。损坏(不是 JSON / 结构不对 / 被截断)时删掉它并返回 undefined,让调用方重新 dump ——
   * 删的只是本服务自己写的缓存文件,重新 dump 若再失败会照常抛错(不静默降级成空数据)。
   */
  private readCache(cacheFile: string): ExtensionApi | undefined {
    try {
      return parseExtensionApi(fs.readFileSync(cacheFile, "utf8"));
    } catch {
      fs.rmSync(cacheFile, { force: true });
      return undefined;
    }
  }

  /** 跑一次 `--dump-extension-api`(cwd 指向缓存目录),校验产物后原子落成缓存文件。 */
  private async dump(root: string, dir: string, cacheFile: string, signal?: AbortSignal): Promise<ExtensionApi> {
    const exe = this.locate();
    fs.mkdirSync(dir, { recursive: true });
    const produced = path.join(dir, EXTENSION_API_FILE);
    fs.rmSync(produced, { force: true });
    const runner = this.opts.runner ?? defaultRunRunner;
    const timeoutMs = this.opts.timeoutMs ?? DUMP_TIMEOUT_MS;

    let res: RunProcessResult;
    try {
      res = await this.opts.runQueue.runExclusive(
        root,
        { tool: "scene_get_node_info", target: EXTENSION_API_FILE },
        (taskSignal) => runner(exe, buildDumpExtensionApiArgs(), { timeoutMs, signal: taskSignal, cwd: dir }),
        { ...(signal ? { signal } : {}) },
      );
    } catch (e) {
      fs.rmSync(produced, { force: true });
      throw mapSpawnError(e, exe);
    }

    const logs = { resolvedPath: exe, stdout: res.stdout, stderr: res.stderr, cacheFile, cwd: dir };
    try {
      // T07:取消不是"引擎失败"。半成品已由 finally 清掉,这里只如实回报进程是否确认退出。
      if (res.aborted) {
        throw new TaskCancelledError("ClassDB API dump was cancelled by the caller", {
          operation: "classdb.dump",
          stage: "cleanup",
          abortSource: "request",
          cleanup: {
            processExitConfirmed: res.exitConfirmed !== false,
            ...(res.pid === undefined ? {} : { pid: res.pid }),
            residual: [],
          },
          ...logs,
        });
      }
      if (res.timedOut) {
        throw new GodotMcpError("GODOT_PROCESS_FAILED", `Godot did not exit within ${timeoutMs}ms while dumping the ClassDB API`, { timeoutMs, ...logs });
      }
      if (res.exitCode !== 0) {
        throw new GodotMcpError("GODOT_PROCESS_FAILED", `Godot exited with code ${res.exitCode} while dumping the ClassDB API`, { exitCode: res.exitCode, ...logs });
      }
      let text: string;
      try {
        text = fs.readFileSync(produced, "utf8");
      } catch {
        throw new GodotMcpError("GODOT_PROCESS_FAILED", `Godot exited successfully but wrote no ${EXTENSION_API_FILE} in ${dir}`, logs);
      }
      const api = parseExtensionApi(text); // 结构不合法 → PARSE_ERROR,由上层看到"引擎产物不可用"
      // 已经解析完才收到取消:不要再往缓存目录提交,直接把这次结果当取消处理。
      throwIfAborted(signal, "classdb.dump", "running");
      fs.rmSync(cacheFile, { force: true });
      fs.renameSync(produced, cacheFile);
      return api;
    } finally {
      fs.rmSync(produced, { force: true }); // 成功时已被 rename 掉;失败/取消时清掉半成品
    }
  }

  private locate(): string {
    try {
      return this.opts.godot.locate().path;
    } catch (e) {
      if (e instanceof GodotMcpError && e.code === "GODOT_NOT_FOUND") throw engineUnavailable(e, this.env());
      throw e;
    }
  }

  /** 与注入的 GodotCliService 使用同一份 env,避免错误细节来自另一个环境。 */
  private env(): NodeJS.ProcessEnv {
    return this.opts.env ?? this.opts.godot.env;
  }

  /** `--version` 只跑一次(按 service 实例记忆)。 */
  private engineVersion(): Promise<string> {
    this.versionPromise ??= this.probeVersion();
    return this.versionPromise;
  }

  private async probeVersion(): Promise<string> {
    try {
      const info = await this.opts.godot.getVersion();
      const raw = info.raw.trim();
      return raw === "" ? info.version : raw;
    } catch (e) {
      if (e instanceof GodotMcpError && e.code === "GODOT_NOT_FOUND") throw engineUnavailable(e, this.env());
      throw e;
    }
  }

  /** `Control.FocusMode` → 该类的枚举;`Error` 这种无前缀名 → 全局枚举;找不到就 undefined(不猜)。 */
  private resolveEnum(api: ExtensionApi, ref: string): ApiEnum | undefined {
    const dot = ref.lastIndexOf(".");
    if (dot < 0) return api.globalEnums.get(ref);
    const owner = api.classes.get(ref.slice(0, dot));
    return owner?.enums.find((e) => e.name === ref.slice(dot + 1));
  }
}

/** 编辑器/动态属性:不是 ClassDB 成员,但 .tscn 里合法出现。 */
const SCENE_PSEUDO_PROPERTIES = new Set(["script", "layout_mode", "anchors_preset"]);

/** 带 `/` 的名字(theme_override_*、metadata/* 等)由 _set/主题系统解析,ClassDB 不提供声明。 */
function isUnverifiableSceneProperty(name: string): boolean {
  return SCENE_PSEUDO_PROPERTIES.has(name) || name.includes("/");
}

/**
 * 与请求名相近的信号名(拼写错误的提示):编辑距离 ≤ 2、或互为前缀的排在前面,最多 5 个。
 * 只是为了给出"你是否想写 pressed"这类提示,不做权威判断。
 */
function closestSignalNames(candidates: readonly string[], wanted: string): string[] {
  const needle = wanted.toLowerCase();
  const scored = candidates
    .map((name) => {
      const lower = name.toLowerCase();
      const distance = editDistance(lower, needle);
      const prefix = lower.startsWith(needle) || needle.startsWith(lower);
      return { name, distance, prefix };
    })
    .filter((x) => x.distance <= 2 || x.prefix)
    .sort((a, b) => (a.prefix === b.prefix ? a.distance - b.distance : a.prefix ? -1 : 1));
  const out: string[] = [];
  for (const x of scored) {
    if (out.length >= 5) break;
    if (!out.includes(x.name)) out.push(x.name);
  }
  return out;
}

/** Levenshtein 距离(信号名很短,直接两行动态规划即可)。 */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!;
      prev[j] = Math.min(
        prev[j]! + 1,
        prev[j - 1]! + 1,
        diagonal + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return prev[b.length]!;
}

/** 粗粒度字面量类别:只用于"明显不匹配"判定,不追求精确类型系统。 */
function inferLiteralKind(raw: string): LiteralKind {
  const s = raw.trim();
  if (s === "true" || s === "false") return "boolean";
  if (s === "null") return "null";
  if (/^-?\d+$/.test(s) || /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return "number";
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) return "string";
  if (s.startsWith("[")) return "array";
  if (s.startsWith("{")) return "dictionary";
  const ctor = /^([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/.exec(s)?.[1];
  switch (ctor) {
    case "Vector2": return "vector2";
    case "Vector2i": return "vector2i";
    case "Vector3": return "vector3";
    case "Vector3i": return "vector3i";
    case "Color": return "color";
    case "Rect2": return "rect2";
    case "NodePath": return "nodepath";
    case "ExtResource":
    case "SubResource":
    case "Resource": return "resource";
    default: break;
  }
  if (ctor !== undefined && ctor.endsWith("Array")) return "array";
  return "unknown";
}

const VECTOR_KINDS = new Set<LiteralKind>(["vector2", "vector2i", "vector3", "vector3i"]);
const BUILTIN_TYPES = new Set([
  "bool", "int", "float", "String", "StringName", "NodePath", "Vector2", "Vector2i", "Vector3", "Vector3i",
  "Vector4", "Vector4i", "Rect2", "Rect2i", "Color", "Transform2D", "Transform3D", "Basis", "Quaternion",
  "Plane", "AABB", "Projection", "Dictionary", "Array", "Variant", "Object", "void",
]);

/** 明显不匹配才返回 "mismatch";类型无法判定时返回 "unknown"(不制造噪音)。 */
function compareLiteralToType(property: ClassInfoProperty, kind: LiteralKind): "match" | "mismatch" | "unknown" {
  if (kind === "unknown") return "unknown";
  if (property.enum !== undefined) return kind === "number" ? "match" : "mismatch";
  const type = property.type.trim();
  if (type === "bool") return kind === "boolean" ? "match" : "mismatch";
  if (type === "int" || type === "float") return kind === "number" ? "match" : "mismatch";
  if (type === "String" || type === "StringName") return kind === "string" ? "match" : "mismatch";
  if (VECTOR_KINDS.has(type as LiteralKind)) return VECTOR_KINDS.has(kind) ? "match" : "mismatch";
  if (type === "Color") return kind === "color" ? "match" : "mismatch";
  if (type === "Rect2" || type === "Rect2i") return kind === "rect2" ? "match" : "mismatch";
  if (type === "NodePath") return kind === "nodepath" || kind === "string" ? "match" : "mismatch";
  if (type === "Dictionary") return kind === "dictionary" ? "match" : "mismatch";
  if (type.startsWith("Array") || type.startsWith("Packed")) return kind === "array" ? "match" : "mismatch";
  if (type === "Object") return kind === "resource" || kind === "null" ? "match" : "mismatch";
  // 其余大写开头且非内建值的类型视为对象/资源(Texture2D、Material、Font …)。
  if (!BUILTIN_TYPES.has(type) && /^[A-Z]/.test(type)) {
    return kind === "resource" || kind === "null" ? "match" : "mismatch";
  }
  return "unknown";
}

/**
 * 写侧工具用:类不存在/非 Node 派生/不可实例化时抛 INVALID_ARGUMENT。
 * ClassDB 不可用(unavailable)不在这里拒绝 —— 调用方必须把它放进返回值。
 */
export function assertUsableNodeClass(validation: NodePropertyValidation): void {
  if (validation.status === "class_missing") {
    throw new GodotMcpError("INVALID_ARGUMENT", `ClassDB has no node class "${validation.nodeType}".`, {
      param: "nodeType", nodeType: validation.nodeType, propertyValidation: validation,
    });
  }
  if (validation.status === "not_a_node") {
    throw new GodotMcpError("INVALID_ARGUMENT", `"${validation.nodeType}" is not a Node subclass and cannot be added to a scene.`, {
      param: "nodeType", nodeType: validation.nodeType, propertyValidation: validation,
    });
  }
  if (validation.status === "not_instantiable") {
    throw new GodotMcpError("INVALID_ARGUMENT", `"${validation.nodeType}" is an abstract class and cannot be instantiated.`, {
      param: "nodeType", nodeType: validation.nodeType, propertyValidation: validation,
    });
  }
}

/** 从 inherits 链走出的祖先列表(父类 → Object);遇到环或缺类就停,不无限循环。 */
function inheritanceOf(api: ExtensionApi, className: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([className]);
  let current = api.classes.get(className)?.inherits;
  while (current !== undefined && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = api.classes.get(current)?.inherits;
  }
  return chain;
}

/** 引擎不可用(未设置 GODOT_PATH 且 PATH 无候选):明确报错并说明为什么需要引擎。 */
function engineUnavailable(cause: GodotMcpError, env: NodeJS.ProcessEnv): GodotMcpError {
  return new GodotMcpError(
    "GODOT_NOT_FOUND",
    "ClassDB class information can only come from the Godot engine, but no Godot executable was found: "
      + "GODOT_PATH is not set and no `godot` candidate was found on PATH. "
      + "Set GODOT_PATH to a Godot executable and retry (the engine API dump is cached afterwards).",
    { ...(cause.details ?? {}), godotPath: env["GODOT_PATH"] ?? null, requiredFor: "ClassDB API dump (extension_api.json)" },
  );
}

/** spawn 阶段错误 → GODOT_NOT_FOUND / GODOT_PROCESS_FAILED(与 RuntimeService 同一套映射)。 */
function mapSpawnError(e: unknown, exe: string): never {
  if (e instanceof GodotMcpError) throw e; // 例如队列等待 LOCK_TIMEOUT,原样透传
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") {
    throw new GodotMcpError("GODOT_NOT_FOUND", `Godot executable disappeared before spawn: ${exe}`, { resolvedPath: exe, reason: "ENOENT" });
  }
  throw new GodotMcpError("GODOT_PROCESS_FAILED", `Failed to spawn Godot: ${exe}`, {
    resolvedPath: exe, reason: typeof err?.code === "string" ? err.code : String(e),
  });
}

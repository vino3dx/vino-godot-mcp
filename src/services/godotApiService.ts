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
  async getClassInfo(projectPath: string | undefined, nodeType: string): Promise<ClassInfo> {
    const requested = typeof nodeType === "string" ? nodeType.trim() : "";
    if (requested === "") {
      throw new GodotMcpError("INVALID_ARGUMENT", "nodeType 不能为空(需要 Godot 类名,如 Node2D)", { param: "nodeType", nodeType });
    }
    const loaded = await this.load(this.opts.project.resolve(projectPath));
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

  async searchClasses(projectPath: string | undefined, query: string, limit = 100): Promise<{ name: string; inherits?: string; apiType: string; isInstantiable: boolean }[]> {
    const loaded = await this.load(this.opts.project.resolve(projectPath)); const q = query.trim().toLowerCase();
    return [...loaded.api.classes.values()].filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, Math.max(1, Math.min(limit, 500))).map((c) => ({ name: c.name, ...(c.inherits ? { inherits: c.inherits } : {}), apiType: c.apiType, isInstantiable: c.isInstantiable }));
  }

  async validateMember(projectPath: string | undefined, className: string, member: { property?: string; method?: string; signal?: string; enumMember?: string }): Promise<{ className: string; exists: boolean; member: typeof member; source: ClassInfo["source"] }> {
    const info = await this.getClassInfo(projectPath, className); const found = member.property ? info.allProperties?.some((p) => p.name === member.property) : member.method ? info.allMethods?.some((m) => m.name === member.method) : member.signal ? info.allSignals?.some((s) => s.name === member.signal) : false;
    return { className, exists: Boolean(found), member, source: info.source };
  }

  /** `<项目根>/.vino-godot-mcp/extension-api/<版本>.json`(对外暴露给测试与文档)。 */
  cacheFileFor(projectRoot: string, version: string): string {
    return path.join(projectRoot, API_CACHE_DIR, API_CACHE_SUBDIR, `${cacheKeyOf(version)}.json`);
  }

  // ────────────────────────────── 内部 ──────────────────────────────

  /** 命中内存/磁盘缓存就直接用;磁盘缓存损坏(解析失败)才删除并重新 dump。 */
  private async load(root: string): Promise<LoadedApi> {
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

    const api = await this.dump(root, path.dirname(cacheFile), cacheFile);
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
  private async dump(root: string, dir: string, cacheFile: string): Promise<ExtensionApi> {
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
        (signal) => runner(exe, buildDumpExtensionApiArgs(), { timeoutMs, signal, cwd: dir }),
      );
    } catch (e) {
      fs.rmSync(produced, { force: true });
      throw mapSpawnError(e, exe);
    }

    const logs = { resolvedPath: exe, stdout: res.stdout, stderr: res.stderr, cacheFile, cwd: dir };
    try {
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
      fs.rmSync(cacheFile, { force: true });
      fs.renameSync(produced, cacheFile);
      return api;
    } finally {
      fs.rmSync(produced, { force: true }); // 成功时已被 rename 掉;失败时清掉半成品
    }
  }

  private locate(): string {
    try {
      return this.opts.godot.locate().path;
    } catch (e) {
      if (e instanceof GodotMcpError && e.code === "GODOT_NOT_FOUND") throw engineUnavailable(e, this.opts.env ?? process.env);
      throw e;
    }
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
      if (e instanceof GodotMcpError && e.code === "GODOT_NOT_FOUND") throw engineUnavailable(e, this.opts.env ?? process.env);
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

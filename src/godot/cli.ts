// Godot CLI 探测:定位可执行文件 + 受控地跑一次 `--version`。
// 刻意不做通用 runGodot(args) 抽象——CLI 契约(输出流/退出码/是否需要 --headless)尚未经 Godot 4.6 实测,
// 等第二个用例出现且契约已验证,再从这里的私有函数提取。
import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { GodotMcpError } from "../core/errors.js";
import { decodeProcessOutput } from "../core/outputEncoding.js";

const execFile = promisify(execFileCb);

/** 冷启动耗时未实测,初值取宽;待 4.6 实测后收紧。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

// ---------- 定位 ----------

/** Godot 实际是从哪里找到的。 */
export type GodotSource = "GODOT_PATH" | "PATH";

export interface GodotCandidate {
  path: string;
  source: GodotSource;
}

export interface ResolveOptions {
  /** 环境变量来源(默认 process.env)。测试可注入。 */
  env?: NodeJS.ProcessEnv;
  /** 覆盖 PATH 目录列表(默认取 env.PATH 按平台分隔符切分)。测试可注入。 */
  pathDirs?: readonly string[];
  /** 解析相对 GODOT_PATH 的基准目录(默认 process.cwd())。 */
  cwd?: string;
}

/**
 * 候选可执行文件名。只保留最有把握的通用名;
 * godot4.exe / Godot_v4.6-stable_win64.exe 等发行命名未经 4.6 实测,不写死——
 * 靠"逐个候选实际跑 --version"来仲裁,而不是靠名字猜。
 */
export function candidateNames(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === "win32" ? ["godot", "godot.exe"] : ["godot"];
}

/** pathDirs × names 的笛卡尔积(纯函数,不碰文件系统)。 */
export function buildCandidatePaths(pathDirs: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of pathDirs) for (const name of names) out.push(path.join(dir, name));
  return out;
}

/**
 * 解析优先级(与 ProjectResolver 的显式 > 环境变量 > 搜索 同构):
 *   GODOT_PATH > PATH 目录 × candidateNames
 * GODOT_PATH 指向不存在的文件时直接抛 GODOT_NOT_FOUND,不静默回退 PATH——
 * 避免在用户明确指定时悄悄用上意料之外的二进制。
 */
export function resolveCandidates(opts: ResolveOptions = {}): GodotCandidate[] {
  const env = opts.env ?? process.env;
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const godotPath = env["GODOT_PATH"];
  if (godotPath !== undefined && godotPath !== "") {
    const abs = path.resolve(cwd, godotPath);
    if (!isFile(abs)) {
      throw new GodotMcpError("GODOT_NOT_FOUND", `GODOT_PATH points to a missing file: ${abs}`, {
        godotPath,
        resolved: abs,
      });
    }
    return [{ path: abs, source: "GODOT_PATH" }];
  }
  const dirs = opts.pathDirs ?? splitPathDirs(env["PATH"]);
  const names = candidateNames();
  const found: GodotCandidate[] = [];
  for (const p of buildCandidatePaths(dirs, [...names])) {
    if (isFile(p)) found.push({ path: p, source: "PATH" });
  }
  return found;
}

// ---------- 版本探测 ----------

export interface RunProbeOptions {
  timeout: number;
}

/** promisified execFile 的最小签名,测试可注入替身。 */
export type GodotRunner = (
  file: string,
  args: readonly string[],
  opts: RunProbeOptions,
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: GodotRunner = async (file, args, opts) => {
  // 不指定 encoding:拿原始字节,再由统一解码器判定 UTF-8 / UTF-16 BOM / Windows 回退。
  const result = await execFile(file, args, { ...opts, windowsHide: true, killSignal: "SIGKILL", encoding: "buffer" }) as unknown as {
    stdout?: Buffer;
    stderr?: Buffer;
  };
  return {
    stdout: decodeProcessOutput(result.stdout ?? Buffer.alloc(0)).text,
    stderr: decodeProcessOutput(result.stderr ?? Buffer.alloc(0)).text,
  };
};

export interface ParsedVersion {
  version: string;
  /** 版本 token 实际来自哪个流。 */
  stream: "stdout" | "stderr";
}

export interface GodotVersionInfo {
  /** 从输出提取的版本 token,如 "4.6"。 */
  version: string;
  /** 版本所在的原始输出,原样透传,不改写不伪造。 */
  raw: string;
  resolvedPath: string;
  source: GodotSource;
}

export interface VersionOptions extends ResolveOptions {
  /** 进程执行器(默认 promisified execFile)。测试可注入。 */
  runner?: GodotRunner;
  timeoutMs?: number;
}

/**
 * 对每个存在的候选执行一次 `--version`,第一个成功者胜出。
 * 全部失败时把每个候选的失败原因放进 details.tried,让名字规则的错误能被运行时证据纠正。
 */
export async function getGodotVersion(opts: VersionOptions = {}): Promise<GodotVersionInfo> {
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates = resolveCandidates(opts);
  if (candidates.length === 0) {
    const env = opts.env ?? process.env;
    throw new GodotMcpError(
      "GODOT_NOT_FOUND",
      "No Godot executable found: GODOT_PATH is not set and no candidate was found on PATH",
      {
        godotPath: env["GODOT_PATH"] ?? null,
        candidates: buildCandidatePaths(opts.pathDirs ?? splitPathDirs(env["PATH"]), [...candidateNames()]),
        tried: [],
      },
    );
  }
  const tried: Array<{ path: string; source: GodotSource; reason: string }> = [];
  for (const c of candidates) {
    try {
      const { stdout, stderr } = await runner(c.path, ["--version"], { timeout: timeoutMs });
      const parsed = parseVersionOutput(stdout, stderr);
      return { version: parsed.version, raw: parsed.stream === "stdout" ? stdout : stderr, resolvedPath: c.path, source: c.source };
    } catch (e) {
      tried.push({ path: c.path, source: c.source, reason: describeProbeError(e) });
    }
  }
  const allMissing = tried.every((t) => t.reason === "ENOENT");
  throw new GodotMcpError(
    allMissing ? "GODOT_NOT_FOUND" : "GODOT_PROCESS_FAILED",
    allMissing
      ? "Godot executable(s) disappeared before the version probe"
      : `None of ${tried.length} Godot candidate(s) produced a recognizable version string`,
    { tried },
  );
}

/**
 * 保守解析:只在输出的开头找 `^<major>.<minor>[.<patch>]`,找不到就报错,绝不猜。
 * stdout 优先,stderr 兜底(4.6 是否改走 stderr 尚未实测)。
 */
export function parseVersionOutput(stdout: string, stderr: string, exitCode = 0): ParsedVersion {
  const fromStdout = VERSION_RE.exec(stdout.trim());
  if (fromStdout?.[0]) return { version: fromStdout[0], stream: "stdout" };
  const fromStderr = VERSION_RE.exec(stderr.trim());
  if (fromStderr?.[0]) return { version: fromStderr[0], stream: "stderr" };
  throw new GodotMcpError(
    "GODOT_PROCESS_FAILED",
    `godot --version produced no recognizable version string (exit code ${exitCode})`,
    { exitCode, stdout: truncate(stdout), stderr: truncate(stderr) },
  );
}

const VERSION_RE = /^\d+\.\d+(?:\.\d+)?/;

function describeProbeError(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { killed?: boolean; exitCode?: number | null };
  if (err?.killed) return "timeout";
  if (err?.code === "ENOENT") return "ENOENT";
  if (typeof err?.exitCode === "number") return `exit=${err.exitCode}`;
  if (typeof err?.code === "string") return err.code;
  return e instanceof Error ? e.message : String(e);
}

function splitPathDirs(raw: string | undefined): string[] {
  return (raw ?? "").split(path.delimiter).map((s) => s.trim()).filter((s) => s !== "");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function truncate(s: string, max = 500): string {
  return s.length <= max ? s : s.slice(0, max) + "...(truncated)";
}

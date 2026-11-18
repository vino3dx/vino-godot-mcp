import fs from "node:fs";
import path from "node:path";
import { GodotMcpError } from "../core/errors.js";
import { findGodotResourceSections, parseGodotResource } from "../core/parser/index.js";
import { ProjectResolver } from "../core/project/projectResolver.js";
import { defaultRunRunner, type GodotRunRunner, type RunProcessResult } from "../godot/runtime/run.js";
import type { GodotCliService } from "./godotCli.js";
import type { GodotSource } from "../godot/cli.js";
import { TaskQueue } from "../core/concurrency/taskQueue.js";
import { throwIfAborted } from "../core/concurrency/cancellation.js";

export interface ValidationIssue {
  type: "SCRIPT_PARSE_ERROR" | "MISSING_RESOURCE" | "RESOURCE_PARSE_ERROR" | "SCENE_LOAD_ERROR" | "RUNTIME_ERROR" | "GODOT_NOT_FOUND" | "TASK_TIMEOUT";
  message: string;
  file?: string;
  line?: number;
  resource?: string;
  details?: Record<string, unknown>;
}

export interface ProjectValidationResult {
  writeSucceeded: null;
  syntaxValidated: boolean;
  resourceValidated: boolean;
  runtimeValidated: boolean;
  issues: ValidationIssue[];
  checkedScripts: string[];
  checkedResources: string[];
  runtime?: { exitCode: number | null; stdout: string; stderr: string; durationMs: number; command: string };
}

interface Options { projectPath?: string; scene?: string; timeoutMs?: number; waitTimeoutMs?: number; tool: string; /** T07:请求级取消信号 */ signal?: AbortSignal }

export class ProjectValidationService {
  constructor(private readonly opts: { godot: GodotCliService; project: ProjectResolver; runQueue: TaskQueue; runner?: GodotRunRunner }) {}

  async validate(o: Options): Promise<ProjectValidationResult> {
    throwIfAborted(o.signal, o.tool, "queue");
    const root = this.opts.project.resolve(o.projectPath);
    const files = collectFiles(root);
    const issues: ValidationIssue[] = [];
    const scripts = files.filter((f) => f.toLowerCase().endsWith(".gd"));
    const resources = files.filter((f) => /\.(tscn|tres)$/i.test(f));
    const checkedScripts = scripts.map((f) => toRes(root, f));
    const checkedResources = resources.map((f) => toRes(root, f));

    let syntaxValidated = true;
    let source: GodotSource | undefined;
    let executable: string | undefined;
    try { ({ path: executable, source } = this.opts.godot.locate()); }
    catch (e) { issues.push(issueFromError(e, "GODOT_NOT_FOUND")); syntaxValidated = false; }

    if (executable && source) {
      for (const file of scripts) {
        // 脚本之间是干净的中断点:一次 --check-only 不写任何项目文件。
        throwIfAborted(o.signal, o.tool, "running");
        const result = await this.run(executable, ["--path", root, "--headless", "--check-only", "--script", toRes(root, file)], root, o);
        if (result.timedOut) { syntaxValidated = false; issues.push({ type: "TASK_TIMEOUT", message: `Script validation timed out: ${toRes(root, file)}`, file: toRes(root, file), details: logs(result) }); continue; }
        if (result.exitCode !== 0) { syntaxValidated = false; issues.push({ type: "SCRIPT_PARSE_ERROR", message: result.stderr || result.stdout || `Godot rejected ${toRes(root, file)}`, file: toRes(root, file), line: extractLine(result.stderr || result.stdout), details: logs(result) }); }
      }
    }

    let resourceValidated = true;
    throwIfAborted(o.signal, o.tool, "running");
    for (const file of resources) {
      let text: string;
      try { text = fs.readFileSync(file, "utf8"); }
      catch { continue; }
      try {
        const ast = parseGodotResource(text);
        for (const ext of findGodotResourceSections(ast, "ext_resource")) {
          const raw = ext.attributes.find((a) => a.name === "path")?.value;
          const resource = raw?.replace(/^"|"$/g, "");
          if (!resource?.startsWith("res://")) continue;
          const target = path.resolve(root, resource.slice("res://".length));
          if (!fs.existsSync(target)) { resourceValidated = false; issues.push({ type: "MISSING_RESOURCE", message: `Missing external resource: ${resource}`, file: toRes(root, file), resource }); }
        }
      } catch (e) { resourceValidated = false; issues.push({ type: "RESOURCE_PARSE_ERROR", message: e instanceof Error ? e.message : String(e), file: toRes(root, file) }); }
    }

    let runtimeValidated = false;
    if (executable && source) {
      const result = await this.run(executable, ["--path", root, "--headless", "--quit", ...(o.scene ? ["--scene", o.scene] : [])], root, o);
      if (result.timedOut) issues.push({ type: "TASK_TIMEOUT", message: "Godot runtime validation timed out", details: logs(result) });
      else if (result.exitCode === 0) runtimeValidated = true;
      else issues.push({ type: "RUNTIME_ERROR", message: result.stderr || result.stdout || `Godot exited with code ${result.exitCode}`, details: logs(result) });
      return { writeSucceeded: null, syntaxValidated, resourceValidated, runtimeValidated, issues, checkedScripts, checkedResources, runtime: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, command: [executable, "--path", root, "--headless", "--quit", ...(o.scene ? ["--scene", o.scene] : [])].join(" ") } };
    }
    return { writeSucceeded: null, syntaxValidated: false, resourceValidated, runtimeValidated, issues, checkedScripts, checkedResources };
  }

  private run(file: string, args: string[], root: string, o: Options): Promise<RunProcessResult> {
    const runner = this.opts.runner ?? defaultRunRunner;
    return this.opts.runQueue.runExclusive(root, { tool: o.tool, target: o.scene ?? root }, (taskSignal) => runner(file, args, { timeoutMs: o.timeoutMs ?? 30_000, signal: taskSignal, cwd: root }), {
      ...(o.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: o.waitTimeoutMs }),
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    });
  }
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.name === ".git" || entry.name === ".godot") continue; const abs = path.join(dir, entry.name); if (entry.isDirectory()) walk(abs); else if (entry.isFile()) out.push(abs); } };
  walk(root); return out;
}
function toRes(root: string, file: string): string { return `res://${path.relative(root, file).replace(/\\/g, "/")}`; }
function extractLine(text: string): number | undefined { const m = /(?:line| at )\s*:?\s*(\d+)/i.exec(text); return m ? Number(m[1]) : undefined; }
function logs(r: RunProcessResult): Record<string, unknown> { return { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, stdoutTruncated: r.stdoutTruncated, stderrTruncated: r.stderrTruncated, durationMs: r.durationMs }; }
function issueFromError(e: unknown, type: "GODOT_NOT_FOUND"): ValidationIssue { return { type, message: e instanceof Error ? e.message : String(e), details: e instanceof GodotMcpError ? e.details : undefined }; }

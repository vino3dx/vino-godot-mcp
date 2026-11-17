import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import { GodotMcpError } from "../../core/errors.js";
import { SCENE_FIRST_POLICY } from "../../services/developmentGuidelines.js";
import type { NodeSignalValidation } from "../../services/godotApiService.js";

/** 信号存在性结论。只有 missing 是"确定不存在"(硬拦截),其余都必须如实回报。 */
type SignalVerdict = "verified" | "declared_in_script" | "missing" | "unverified";

interface SignalCheck {
  verdict: SignalVerdict;
  /** 源节点类型(`[node]` 段头的 type=);实例节点/无 type 时为空。 */
  nodeType?: string;
  signal: string;
  /** 声明该信号的类(ClassDB)或脚本路径(脚本声明)。 */
  declaredBy?: string;
  /** 名字相近的信号,用于提示拼写错误。 */
  suggestions?: string[];
  reason?: string;
  warnings: string[];
}

export const sceneConnectSignal: ToolDefinition<AppContext> = {
  name: "scene_connect_signal",
  domain: "scene",
  description:
    "Connect a signal in a .tscn scene by writing a persisted [connection] section (lossless; the section is appended after the existing nodes/connections). " +
    "Both nodes must exist in the same scene. An identical signal/from/to/method connection is reported as a duplicate error. " +
    "The signal name is verified before writing: the source node's type= is looked up in ClassDB (engine API dump), and signals declared by the node's own GDScript chain are accepted too. " +
    "A name that provably does not exist (e.g. 'press' instead of 'pressed') is rejected with INVALID_ARGUMENT instead of writing a connection Godot would silently drop. " +
    "When no Godot executable is configured, or the type/script cannot be resolved statically (instance nodes, GDExtension classes), the write proceeds and the result reports signalValidation.status='unverified' plus a warning. " +
    "flags is a bit mask (CONNECT_DEFERRED=1, CONNECT_PERSIST=2, CONNECT_ONE_SHOT=4). CONNECT_PERSIST is implied for connections stored in a .tscn, so only the other bits (1|4|8|...) make a flags= field appear (verified against Godot 4.6.3). " +
    SCENE_FIRST_POLICY,
  inputSchema: {
    type: "object",
    required: ["path", "sourcePath", "signal", "targetPath", "method"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      sourcePath: { type: "string", description: "Node that emits the signal ('.' = scene root)." },
      signal: { type: "string", description: "Signal name (Godot identifier, e.g. 'ready', 'pressed'). Verified against ClassDB and the node's script chain before writing." },
      targetPath: { type: "string", description: "Node that receives the call ('.' = scene root)." },
      method: { type: "string", description: "Method name on the target node (Godot identifier)." },
      flags: { type: "integer", minimum: 0, description: "Connection flag bit mask: CONNECT_DEFERRED=1, CONNECT_PERSIST=2, CONNECT_ONE_SHOT=4. CONNECT_PERSIST is implied in a .tscn, so 1 is written as flags=3 and 0 writes no flags= field." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const projectPath = args["projectPath"] as string | undefined;
    const signalName = args["signal"] as string;
    const sourcePath = args["sourcePath"] as string;
    // D3:先做信号存在性校验再落盘(拼错的信号名写进去后引擎加载时才会报错,或根本静默失效)
    const read = ctx.file.read(projectPath, args["path"] as string);
    const check = await checkSignal(ctx, projectPath, read.text, sourcePath, signalName);
    if (check.verdict === "missing") {
      const hint = check.suggestions && check.suggestions.length > 0
        ? ` Did you mean ${check.suggestions.map((s) => `'${s}'`).join(" / ")}?`
        : "";
      throw new GodotMcpError(
        "INVALID_ARGUMENT",
        `Node type '${check.nodeType ?? "?"}' has no signal '${signalName}'.${hint}`,
        {
          param: "signal",
          nodePath: sourcePath,
          nodeType: check.nodeType ?? null,
          signal: signalName,
          ...(check.suggestions === undefined ? {} : { suggestions: check.suggestions }),
          declaredBy: check.declaredBy ?? null,
        },
      );
    }

    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      projectPath,
      args["path"] as string,
      (text) => {
        const r = ctx.scene.connectSignal(text, {
          sourcePath,
          signal: signalName,
          targetPath: args["targetPath"] as string,
          method: args["method"] as string,
          ...(args["flags"] !== undefined ? { flags: args["flags"] as number } : {}),
        });
        summary = { status: "connected", flags: r.flags };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    return {
      data: {
        ...data,
        ...summary,
        signalValidation: {
          status: check.verdict,
          source: check.verdict === "declared_in_script" ? "script" : check.verdict === "verified" ? "classdb" : "none",
          nodeType: check.nodeType ?? null,
          signal: signalName,
          ...(check.declaredBy === undefined ? {} : { declaredBy: check.declaredBy }),
          ...(check.suggestions === undefined ? {} : { suggestions: check.suggestions }),
          ...(check.reason === undefined ? {} : { reason: check.reason }),
        },
      },
      ...(check.warnings.length > 0 ? { warnings: check.warnings } : {}),
    };
  },
};

/**
 * 判断源节点是否真的具备该信号。结论分四档:
 *   - verified:ClassDB(含继承链)声明了它;
 *   - declared_in_script:节点挂载的 .gd 继承链里有 `signal <name>`;
 *   - missing:**确定不存在**(类型已知、ClassDB 判定无此信号、脚本链完整且没声明)→ 调用方硬拦截;
 *   - unverified:无法静态判定(无引擎、实例节点、GDExtension/插件类、脚本链读不全)→ 只警告,不拦。
 * 绝不把"没查到"当成"不存在" —— 那会拦掉合法的自定义/插件信号。
 */
async function checkSignal(
  ctx: AppContext,
  projectPath: string | undefined,
  sceneText: string,
  sourcePath: string,
  signalName: string,
): Promise<SignalCheck> {
  // 语法非法交给 sceneService 报更准确的错;这里不做 ClassDB 查询(避免无意义的引擎启动)
  if (!/^[A-Za-z_]\w*$/.test(signalName)) {
    return { verdict: "unverified", signal: signalName, reason: "signal is not a valid Godot identifier; static check skipped", warnings: [] };
  }
  const node = ctx.scene.getNodeType(sceneText, sourcePath);
  if (node === undefined) {
    return { verdict: "unverified", signal: signalName, reason: "source node not found in this scene; static check skipped", warnings: [] };
  }
  if (node.type === undefined) {
    return {
      verdict: "unverified", signal: signalName, reason: "node segment has no type= (instance node); ClassDB check skipped", warnings: [],
    };
  }

  const validation: NodeSignalValidation = await ctx.godotApi.validateNodeSignal(projectPath, node.type, signalName);
  if (validation.status === "verified" && validation.hasSignal) {
    return {
      verdict: "verified",
      nodeType: validation.nodeType,
      signal: signalName,
      ...(validation.declaredBy === undefined ? {} : { declaredBy: validation.declaredBy }),
      warnings: [],
    };
  }
  if (validation.status === "class_missing" || validation.status === "not_a_node" || validation.status === "unavailable") {
    // 类型来自场景文件本身(GDExtension/插件类),或引擎不可用:不能据此断言信号不存在
    return {
      verdict: "unverified",
      nodeType: node.type,
      signal: signalName,
      reason: validation.reason ?? `ClassDB could not verify node type '${node.type}'`,
      warnings: [
        `Signal '${signalName}' could not be verified: ${validation.reason ?? `ClassDB has no entry for '${node.type}'`} `
          + "The connection was written as requested; verify it in the Godot editor.",
      ],
    };
  }

  // ClassDB 说没有:脚本可能自己声明了 `signal <name>`
  if (node.script !== undefined) {
    const scan = await scanScriptSignals(ctx, projectPath, node.script);
    if (scan.signals.has(signalName)) {
      return {
        verdict: "declared_in_script", nodeType: node.type, signal: signalName, declaredBy: scan.declaredBy, warnings: [],
      };
    }
    if (!scan.complete) {
      return {
        verdict: "unverified",
        nodeType: node.type,
        signal: signalName,
        ...(validation.suggestions === undefined ? {} : { suggestions: validation.suggestions }),
        reason: `class '${node.type}' does not declare it and the attached script chain (${node.script}) could not be fully resolved`,
        warnings: [
          `Signal '${signalName}' is not declared by '${node.type}' in ClassDB and the attached script chain could not be fully read `
            + `(${node.script}); the connection was written, verify it in the Godot editor.`,
        ],
      };
    }
  }

  return {
    verdict: "missing",
    nodeType: node.type,
    signal: signalName,
    ...(validation.suggestions === undefined ? {} : { suggestions: validation.suggestions }),
    warnings: [],
  };
}

/** 脚本继承链的信号扫描结果。complete=false 表示链上有读不到的目标,"没找到"不能当成"不存在"。 */
interface ScriptSignalScan { signals: Set<string>; declaredBy?: string; complete: boolean }

/**
 * 沿 `extends` 链收集脚本里声明的信号名(只读文本,不执行脚本)。
 * 链的终点只有两种算"完整":`extends` 到 ClassDB 认得的类(类信号已由 ClassDB 校验覆盖),
 * 或读到无 `extends` 的脚本 —— 后者其实不可能出现,按不完整处理。
 */
async function scanScriptSignals(
  ctx: AppContext,
  projectPath: string | undefined,
  scriptPath: string,
): Promise<ScriptSignalScan> {
  const signals = new Set<string>();
  let declaredBy: string | undefined;
  const seen = new Set<string>();
  let current: string | undefined = scriptPath;

  while (current !== undefined) {
    if (seen.has(current)) return { signals, ...(declaredBy === undefined ? {} : { declaredBy }), complete: false };
    seen.add(current);
    let text: string;
    try {
      text = ctx.file.read(projectPath, current).text;
    } catch {
      return { signals, ...(declaredBy === undefined ? {} : { declaredBy }), complete: false };
    }
    const info = ctx.script.getScriptInfo(text);
    if (info.signals.length > 0) declaredBy ??= current;
    for (const s of info.signals) signals.add(s.name);

    const base = info.extends;
    if (base === undefined) return { signals, ...(declaredBy === undefined ? {} : { declaredBy }), complete: false };
    if (base.startsWith("res://") || base.endsWith(".gd")) {
      current = base.startsWith("res://") ? base : resolveRelativeScript(current, base);
      continue;
    }
    if (base.endsWith(".cs") || base.includes("::")) {
      return { signals, ...(declaredBy === undefined ? {} : { declaredBy }), complete: false };
    }
    // `extends <标识符>`:ClassDB 认得 → 链完整;否则可能是 class_name 脚本,再去工程里找
    const native = await classDbHasClass(ctx, projectPath, base);
    if (native === true) return { signals, ...(declaredBy === undefined ? {} : { declaredBy }), complete: true };
    if (native === undefined) return { signals, ...(declaredBy === undefined ? {} : { declaredBy }), complete: false };
    const resolved = resolveProjectClass(ctx, projectPath, base);
    if (resolved === undefined) return { signals, ...(declaredBy === undefined ? {} : { declaredBy }), complete: false };
    current = resolved;
  }
  return { signals, ...(declaredBy === undefined ? {} : { declaredBy }), complete: true };
}

/** `extends "base.gd"`(相对写法)按当前脚本目录拼成 res:// 绝对路径。 */
function resolveRelativeScript(current: string, base: string): string {
  const dir = current.slice(0, current.lastIndexOf("/"));
  const parts = `${dir}/${base}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `res://${out.join("/")}`;
}

/** 该名字是否是 ClassDB 里的类:true=是,false=否,undefined=引擎不可用(无法判定)。 */
async function classDbHasClass(ctx: AppContext, projectPath: string | undefined, name: string): Promise<boolean | undefined> {
  try {
    await ctx.godotApi.getClassInfo(projectPath, name);
    return true;
  } catch (e) {
    if (e instanceof GodotMcpError && e.code === "INVALID_ARGUMENT" && e.details?.["param"] === "nodeType") return false;
    return undefined;
  }
}

/** `class_name` → 脚本路径(只在这个兜底分支才扫工程;扫不动就当不确定)。 */
function resolveProjectClass(ctx: AppContext, projectPath: string | undefined, className: string): string | undefined {
  try {
    const graph = ctx.gdscriptProject.analyze(projectPath);
    return graph.scripts.find((s) => s.className === className)?.path;
  } catch {
    return undefined;
  }
}

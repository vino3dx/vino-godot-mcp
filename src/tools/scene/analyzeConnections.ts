import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

type Diagnostic = { severity: "error" | "warning" | "info" | "unknown"; code: string; message: string; source?: string; target?: string; signal?: string; method?: string; suggestion?: string };
export const sceneAnalyzeConnections: ToolDefinition<AppContext> = {
  name: "scene_analyze_connections", domain: "scene",
  description: "Analyze serialized scene signal connections against the static node tree and attached scripts. It never executes scripts and explicitly reports unknown runtime/dynamic cases.",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, projectPath: { type: "string" } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const read = ctx.file.read(args.projectPath as string | undefined, args.path as string);
    const tree = ctx.scene.getSceneTree(read.text); const nodes = new Map(tree.nodes.map((n) => [n.path, n])); const diagnostics: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const c of tree.connections) {
      const key = `${c.source}|${c.signal}|${c.target}|${c.method}`;
      if (seen.has(key)) diagnostics.push({ severity: "warning", code: "DUPLICATE_CONNECTION", message: "重复的静态信号连接", source: c.source, target: c.target, signal: c.signal, method: c.method, suggestion: "删除重复的 [connection] 段。" });
      seen.add(key);
      const source = nodes.get(c.source === "." ? tree.root?.path ?? "." : c.source); const target = nodes.get(c.target === "." ? tree.root?.path ?? "." : c.target);
      if (!source) diagnostics.push({ severity: "error", code: "SOURCE_NODE_MISSING", message: "连接源节点无法在当前场景静态树中解析", source: c.source, target: c.target, signal: c.signal, method: c.method, suggestion: "检查 from 路径或实例边界。" });
      if (!target) diagnostics.push({ severity: "error", code: "TARGET_NODE_MISSING", message: "连接目标节点无法在当前场景静态树中解析", source: c.source, target: c.target, signal: c.signal, method: c.method, suggestion: "检查 to 路径或实例边界。" });
      if (target?.script && target.script.startsWith("res://")) {
        try {
          const script = ctx.file.read(args.projectPath as string | undefined, target.script).text;
          if (!new RegExp(`\\bfunc\\s+${escapeRegExp(c.method)}\\s*\\(`).test(script)) diagnostics.push({ severity: "warning", code: "METHOD_NOT_FOUND_IN_SCRIPT", message: "目标脚本中未找到该回调方法；继承方法或动态方法仍可能存在", source: c.source, target: c.target, signal: c.signal, method: c.method, suggestion: "确认方法名称，或使用运行时检查。" });
        } catch { diagnostics.push({ severity: "unknown", code: "SCRIPT_UNAVAILABLE", message: "目标节点脚本无法读取，回调方法未验证", target: c.target, method: c.method }); }
      } else if (target) diagnostics.push({ severity: "unknown", code: "METHOD_UNVERIFIED", message: "目标节点没有可静态读取的脚本，回调方法未验证", target: c.target, method: c.method });
      diagnostics.push({ severity: "info", code: "SIGNAL_UNVERIFIED", message: "信号名称存在于场景连接中，但未通过 ClassDB 静态确认", source: c.source, target: c.target, signal: c.signal, method: c.method });
    }
    return { data: { resPath: read.resPath, hash: read.hash, source: "static_scene_and_scripts", connections: tree.connections, diagnostics, limitations: ["不执行脚本", "无法确认动态 connect/disconnect", "无法确认继承链上的方法和信号", "实例场景内部节点不展开"] } };
  },
};
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

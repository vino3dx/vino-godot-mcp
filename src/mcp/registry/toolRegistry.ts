import type { ToolDefinition, ToolDomain } from "../../types/index.js";

const NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** 工具注册表:新增工具只需 register,不改 MCP Server 核心。 */
export class ToolRegistry<Ctx> {
  private readonly tools = new Map<string, ToolDefinition<Ctx>>();

  register(def: ToolDefinition<Ctx>): this {
    if (!NAME_RE.test(def.name)) throw new Error(`Invalid tool name "${def.name}" (expected <domain>_<action>, snake_case)`);
    if (!def.name.startsWith(def.domain + "_")) throw new Error(`Tool "${def.name}" must start with its domain "${def.domain}_"`);
    if (this.tools.has(def.name)) throw new Error(`Duplicate tool name "${def.name}"`);
    if (def.inputSchema.type !== "object") throw new Error(`Tool "${def.name}" inputSchema must be an object schema`);
    if (def.annotations.readOnly && def.annotations.destructive) throw new Error(`Tool "${def.name}" cannot be both readOnly and destructive`);
    this.tools.set(def.name, def);
    return this;
  }

  registerAll(defs: ToolDefinition<Ctx>[]): this { defs.forEach((d) => this.register(d)); return this; }

  get(name: string): ToolDefinition<Ctx> | undefined { return this.tools.get(name); }

  /** enabledDomains 为空 = 全部启用(按组按需加载)。 */
  list(enabledDomains?: ReadonlySet<ToolDomain>): ToolDefinition<Ctx>[] {
    const all = [...this.tools.values()];
    return enabledDomains && enabledDomains.size > 0 ? all.filter((t) => enabledDomains.has(t.domain)) : all;
  }

  get size(): number { return this.tools.size; }
}

/** 解析环境变量 VINO_GODOT_MCP_GROUPS="project,shader"。 */
export function parseEnabledDomains(raw: string | undefined): Set<ToolDomain> {
  return new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean) as ToolDomain[]);
}


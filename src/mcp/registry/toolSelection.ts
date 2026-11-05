// P1-C: 工具暴露策略(筛选层)。
//
// 职责分离:
//   ToolDefinition  描述"这个工具是什么"(domain / dependency / 权限注解)
//   ToolSelection   决定"这一次运行暴露哪些工具"(preset / groups)
//
// 规则(两者正交,取交集):
//
//   最终工具集合 = Preset 的 dependency 范围 ∩ Group 的 domain 范围
//
//   - Preset 控制"需要哪种外部能力",未配置时为 default。
//   - Group  控制"属于哪个功能领域",未配置时不做额外过滤(与旧行为一致)。
//   - runtimeRequired 不参与筛选:它只是历史运行状态提示,不代表调用依赖。
//
// 筛选发生在 ToolRegistry 注册之前:被排除的工具根本不进注册表,
// 因此 tools/list 看不到它们,也不需要动态 tools/list / listChanged。
//
// 配置解析集中在本模块:其它层不要再自己读 VINO_GODOT_MCP_PRESET / _GROUPS。
import { GodotMcpError } from "../../core/errors.js";
import type { ToolDefinition, ToolDependency, ToolDomain } from "../../types/index.js";

export type ToolPreset = "default" | "runtime" | "editor" | "full";

/**
 * 预设 → 允许的 dependency 集合。
 * 不在这里写"每种预设多少个工具":数量由实际 Registry 现算。
 */
export const TOOL_PRESET_DEPENDENCIES: Readonly<Record<ToolPreset, readonly ToolDependency[]>> = {
  // 只用 Node + 本地文件系统,任何环境都能跑。
  default: ["none"],
  // 文件级 + Godot 引擎(CLI 探测 / headless / ClassDB dump / 引擎校验)。
  runtime: ["none", "godot"],
  // 文件级 + 运行中的 Editor Bridge。
  editor: ["none", "bridge"],
  // 全部:包含同时需要引擎与编辑器桥的工具。
  full: ["none", "godot", "bridge"],
};

export const PRESET_ENV = "VINO_GODOT_MCP_PRESET";
export const GROUPS_ENV = "VINO_GODOT_MCP_GROUPS";

const ALL_DEPENDENCIES: readonly ToolDependency[] = ["none", "godot", "bridge"];
const ALL_PRESETS = Object.keys(TOOL_PRESET_DEPENDENCIES) as ToolPreset[];

export interface ToolSelectionInput {
  [key: string]: string | undefined;
}

/**
 * 预设是怎么定下来的,用于日志与测试区分"默认值"和"兼容旧配置":
 * - `default`:两个变量都没配置 → 只暴露 none。
 * - `env`:显式配置了 VINO_GODOT_MCP_PRESET → 严格按该预设过滤。
 * - `legacy-groups`:只配置了 VINO_GODOT_MCP_GROUPS → 不做 dependency 过滤(等价 full),保持旧行为。
 */
export type PresetSource = "default" | "env" | "legacy-groups";

export interface ToolSelection<Ctx> {
  preset: ToolPreset;
  /** 预设来源:决定 preset 是默认值、显式配置,还是仅 GROUPS 时的向后兼容结果。 */
  presetSource: PresetSource;
  /** 本预设允许的 dependency(便于诊断输出/测试断言)。 */
  dependencies: readonly ToolDependency[];
  /** 空集合 = 不按领域过滤。 */
  domains: ReadonlySet<ToolDomain>;
  /** 最终注册的工具集合(原始 ToolDefinition 对象,未做任何改写)。 */
  tools: ToolDefinition<Ctx>[];
}

/** 未知预设必须报错:静默回退成 default 会让用户以为配置生效了。 */
export function parseToolPreset(raw: string | undefined): ToolPreset {
  const text = (raw ?? "").trim().toLowerCase();
  if (text === "") return "default";
  if (ALL_PRESETS.includes(text as ToolPreset)) return text as ToolPreset;
  throw new GodotMcpError("INVALID_CONFIGURATION", `Unknown tool preset "${raw}" (${PRESET_ENV}); valid presets: ${ALL_PRESETS.join(", ")}`, {
    preset: raw,
    env: PRESET_ENV,
    validPresets: ALL_PRESETS,
  });
}

/**
 * comma 分隔的 domain 过滤。空值 = 不过滤(保持旧 VINO_GODOT_MCP_GROUPS 语义)。
 * trim + lowercase 与预设保持一致;未知 domain 报错:拼错一个名字就静默少暴露工具,
 * 比启动失败更难排查。
 */
export function parseToolGroups(raw: string | undefined, knownDomains: ReadonlySet<ToolDomain>): Set<ToolDomain> {
  const names = (raw ?? "").split(",").map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0);
  const unknown = names.filter((name) => !knownDomains.has(name as ToolDomain));
  if (unknown.length > 0) {
    const valid = [...knownDomains].sort();
    throw new GodotMcpError("INVALID_CONFIGURATION", `Unknown tool group(s) "${unknown.join(", ")}" (${GROUPS_ENV}); valid groups: ${valid.join(", ")}`, {
      env: GROUPS_ENV,
      unknown,
      validGroups: valid,
    });
  }
  return new Set(names as ToolDomain[]);
}

/**
 * 唯一筛选点:先防御性校验每个工具的 dependency,再取 preset ∩ group。
 * 依赖缺失/非法时宁可启动失败,也不静默少暴露工具。
 */
export function selectTools<Ctx>(
  tools: readonly ToolDefinition<Ctx>[],
  options: { preset: ToolPreset; domains: ReadonlySet<ToolDomain> },
): ToolDefinition<Ctx>[] {
  for (const tool of tools) {
    if (!ALL_DEPENDENCIES.includes(tool.dependency)) {
      throw new GodotMcpError("INVALID_CONFIGURATION", `Tool "${tool.name}" declares an invalid dependency "${String(tool.dependency)}"`, {
        tool: tool.name,
        validDependencies: ALL_DEPENDENCIES,
      });
    }
  }
  const allowed = new Set<ToolDependency>(TOOL_PRESET_DEPENDENCIES[options.preset]);
  const groupFilter = options.domains.size > 0;
  const selected = tools.filter((tool) => allowed.has(tool.dependency) && (!groupFilter || options.domains.has(tool.domain)));
  if (selected.length === 0) {
    const groups = [...options.domains].sort();
    // 哪个预设能救这组 groups:直接算出来,别让用户自己猜。
    const suggestedPresets = ALL_PRESETS.filter((preset) => tools.some((tool) => TOOL_PRESET_DEPENDENCIES[preset].includes(tool.dependency) && (!groupFilter || options.domains.has(tool.domain))));
    const hint = suggestedPresets.length > 0
      ? `Fix: set ${PRESET_ENV}=${suggestedPresets.join("|")} (or remove ${GROUPS_ENV}).`
      : `Fix: change ${GROUPS_ENV} to a group that exists in this build.`;
    throw new GodotMcpError(
      "TOOL_SELECTION_EMPTY",
      `The tool selection exposes no tools: preset "${options.preset}" allows dependencies [${TOOL_PRESET_DEPENDENCIES[options.preset].join(", ")}], and no tool in groups [${groups.join(", ") || "all"}] has one. ${hint}`,
      {
        preset: options.preset,
        dependencies: TOOL_PRESET_DEPENDENCIES[options.preset],
        groups,
        totalTools: tools.length,
        suggestedPresets,
      },
    );
  }
  return selected;
}

/**
 * 环境变量唯一入口:读 PRESET / GROUPS → 最终工具集合。
 *
 * 兼容规则(P1-C 修复):
 *   1. 两个都没配置          → preset=default(只暴露 none)。
 *   2. 只配置 GROUPS         → 不做 dependency 过滤(等价 full),仅按 Group 过滤 = 旧行为。
 *   3. 显式配置 PRESET       → 严格按 preset ∩ groups。
 *   4. 两者都配置            → 同上,交集。
 */
export function resolveToolSelection<Ctx>(
  tools: readonly ToolDefinition<Ctx>[],
  env: ToolSelectionInput = {},
): ToolSelection<Ctx> {
  const presetExplicit = (env[PRESET_ENV] ?? "").trim() !== "";
  const knownDomains = new Set<ToolDomain>(tools.map((tool) => tool.domain));
  const domains = parseToolGroups(env[GROUPS_ENV], knownDomains);
  const groupsExplicit = domains.size > 0;
  // 只写 GROUPS 的旧配置不能因为默认预设而突然少工具或直接起不来。
  const preset: ToolPreset = presetExplicit ? parseToolPreset(env[PRESET_ENV]) : groupsExplicit ? "full" : "default";
  const presetSource: PresetSource = presetExplicit ? "env" : groupsExplicit ? "legacy-groups" : "default";
  return {
    preset,
    presetSource,
    dependencies: TOOL_PRESET_DEPENDENCIES[preset],
    domains,
    tools: selectTools(tools, { preset, domains }),
  };
}

/** 诊断用的一行摘要(写 stderr,不进 stdout 的协议流)。 */
export function describeToolSelection(selection: ToolSelection<unknown>, total: number): string {
  return `tool selection: preset=${selection.preset} source=${selection.presetSource} dependencies=${selection.dependencies.join("+")} groups=${[...selection.domains].sort().join(",") || "all"} tools=${selection.tools.length}/${total}`;
}

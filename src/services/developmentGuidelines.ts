// 项目级开发原则:唯一文案来源。
// 工具描述与 README 都引用这里的一句话,避免各写一份后逐渐漂移。
// 该模块只导出常量,不依赖任何其他模块(services 层允许无依赖)。
//
// 原则本身不是工具功能:它约束"固定结构写 .tscn、动态行为写 .gd"的选择,
// 不新增工具、不改参数。V1.3 的 project_get_development_guidelines 可直接复用本结构。

/** 工具描述内嵌的一句话(保持英文,与工具描述语言一致)。 */
export const SCENE_FIRST_POLICY =
  "Scene-First: fixed scene structure, node hierarchy, properties, resource references and fixed signal connections belong in the .tscn (editor-visible); create nodes in GDScript at runtime only for genuinely dynamic content and behavior.";

export interface DevelopmentGuideline {
  area: string;
  rules: string[];
}

/** 结构化规范;README 与后续 guidelines 工具共用同一份内容。 */
export const DEVELOPMENT_GUIDELINES: readonly DevelopmentGuideline[] = [
  {
    area: "Scene Architecture",
    rules: [
      "Prefer native .tscn scenes and an editor-visible node hierarchy.",
      "Put fixed scene structure, node hierarchy, node properties and resource references in the .tscn.",
      "Avoid building fixed scene trees at runtime in _ready().",
    ],
  },
  {
    area: "Node Management",
    rules: [
      "Use scene_add_node / scene_add_visual_node for static nodes.",
      "Use scene_update_node_property and scene_set_ui_layout for properties and layout.",
      "Use scene_connect_signal for fixed signal connections.",
    ],
  },
  {
    area: "Script Architecture",
    rules: [
      "Keep business logic, state management and algorithms in GDScript.",
      "Do not generate entire scene trees in _ready(); create nodes dynamically only when the content is genuinely dynamic.",
      "Avoid unnecessary runtime signal connections for wiring that never changes.",
    ],
  },
  {
    area: "Resource Management",
    rules: [
      "Prefer reusable .tres resources for configuration and data.",
      "Keep resource references explicit; do not hide them behind load() calls in code.",
    ],
  },
];

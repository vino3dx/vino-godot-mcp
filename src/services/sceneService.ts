// SceneService:.tscn 场景树的结构化读取与无损修改。
//
// 纯逻辑:入参/出参都是文本,不接触文件系统、不加锁、不碰 Runtime —— 落盘与并发由更上层负责。
// 依赖 core/parser:
//   - index.js:parseGodotResource / serializeGodotResource / findGodotResourceSections / getGodotSceneNodes
//   - internal.js:scanBalance(写入前拒绝会破坏文件的属性值;括号/引号平衡语义的唯一实现处)
//   - literal.js:写侧工具回报的结构化前后值(文件静态值,不是引擎布局后的值)
// 格式依据见 src/core/parser/godotResource.ts 与 types.ts 顶部的 4.7.2 源码行号(段头属性、`name = value`)。
//
// 读侧(T7)除节点树外还返回 `[connection]` 列表与实例节点的覆盖属性;写入侧对**实例节点**做两条
// 额外校验(只写当前文件的覆盖、字面量类型明显不符时报错),两条都只用文本,不依赖引擎。
import { GodotMcpError } from "../core/errors.js";
import { findHeaderEnd, scanBalance, skipSpace, splitArrayElements, unquote } from "../core/parser/internal.js";
import {
  findGodotResourceSections,
  getGodotSceneNodes,
  parseGodotResource,
  serializeGodotResource,
  type GodotLineEnding,
  type GodotNodeAST,
  type GodotResourceAST,
  type GodotResourceAttribute,
  type GodotResourceBodyEntry,
  type GodotResourceProperty,
  type GodotResourceSection,
} from "../core/parser/index.js";
import { literalChange, toLiteral, type Literal, type LiteralChange } from "../core/parser/literal.js";

/** 场景根节点的规范路径。 */
const ROOT = ".";

/**
 * 属于 `[node ...]` 段头的字段。它们由段头表达(改名/改父节点/分组等),不能当普通属性写进段体,
 * 否则会写出与段头冲突的重复字段。这些操作留给后续的 renameNode / reparentNode 等专用 API。
 */
const NODE_HEADER_ATTRS = new Set([
  "name", "type", "parent", "index", "unique_id", "instance", "instance_placeholder", "groups", "node_paths", "owner",
]);

/** 场景内一个节点(结构化视图)。 */
export interface SceneNode {
  name: string;
  /** 规范节点路径:根为 ".",子节点为 "Player",孙节点为 "Player/Sprite"。 */
  path: string;
  /** 父节点路径;根节点为 undefined。 */
  parentPath?: string;
  type?: string;
  /** 挂载脚本:解析成功的 `res://` 路径;解析不到时保留 `ExtResource("id")` 原文。 */
  script?: string;
  /** 实例化来源:`instance=ExtResource("id")` 解析出的 `res://` 路径,解析不到时保留原文(旧字段,与 instanceScene 同源)。 */
  instance?: string;
  /** 是否为子场景实例(段头带 `instance=` 或 `instance_placeholder=`)。 */
  isInstance: boolean;
  /** 实例的来源场景 `res://` 路径;**只有解析得到时才出现**(解析不到时不猜,原文仍见 `instance`)。 */
  instanceScene?: string;
  /** 实例节点上的覆盖属性(= 段体属性原文,含 `script`);非实例节点不出现该字段。 */
  overrides?: Array<{ name: string; value: string }>;
  uniqueId?: number;
  groups: string[];
  /** 段体属性(值已去掉 `=` 后的分隔空白)。 */
  properties: Array<{ name: string; value: string }>;
  children: SceneNode[];
}

/**
 * 一条 `[connection]`(信号连接)。
 * flags 的读回规则依据 4.6.3 实测(见 tests/fixtures/SOURCE.md 第六节):
 * 引擎**加载** .tscn 时会并入 `CONNECT_PERSIST(2)|CONNECT_INHERITED(32)`,但**保存/写文件**时会剥掉 32。
 * 所以这里的 `flags.raw` 是文件里的原始数字,`semantic` 只解释文件里真实出现的位,
 * 不把引擎隐含的 INHERITED(32) 算进来 —— 读回因此与写入规则(见 connectSignal)互逆。
 */
export interface SceneConnectionFlags {
  /** 文件里 `flags=` 的原始数值;文件没写该字段时为 null(不伪造 0)。 */
  raw: number | null;
  /** raw 里已命名的位:`DEFERRED`(1)/`PERSIST`(2)/`ONE_SHOT`(4)/`REFERENCE_COUNTED`(8)/`APPEND_SOURCE_OBJECT`(16)。 */
  semantic: string[];
  /** raw 里其余已置位的值(升序),例如 INHERITED 的 32;命名位不重复出现。 */
  otherBits: number[];
}

export interface SceneConnection {
  /** `from=` 的节点路径(场景根为 ".");与 SceneNode.path 同一套写法。 */
  source: string;
  signal: string;
  target: string;
  method: string;
  flags: SceneConnectionFlags;
}

export interface SceneTree {
  /** 场景根节点(无 `[node]` 段时为 undefined,例如 .tres)。 */
  root?: SceneNode;
  /** 全部节点,深度优先(根在前);文件里引用不到的节点排在最后,不丢。 */
  nodes: SceneNode[];
  /** 文件里的 `[connection]` 段,按出现顺序。 */
  connections: SceneConnection[];
}

/** 精简节点:只保留构建/定位需要的信息,不重复 path/parentPath/properties。 */
export interface BriefSceneNode {
  name: string;
  type?: string;
  script?: string;
  isInstance?: boolean;
  instanceScene?: string;
  groups?: string[];
  children?: BriefSceneNode[];
}

/** brief 模式的场景视图:一棵嵌套树 + 连接;不含与 root 重复的 nodes 扁平数组。 */
export interface BriefSceneTree {
  root?: BriefSceneNode;
  connections: SceneConnection[];
  nodeCount: number;
}

export interface SceneFindOptions {
  name?: string;
  type?: string;
  pathPrefix?: string;
  group?: string;
  script?: string;
  isInstance?: boolean;
  /** Exact node path; when includeSubtree=true this becomes a subtree query. */
  nodePath?: string;
  includeSubtree?: boolean;
  /** Static category heuristic; does not claim full ClassDB inheritance. */
  typeCategory?: "control" | "node2d" | "container" | "node";
  maxResults?: number;
}

/** scene_add_node 的入参。 */
export interface AddNodeOptions {
  /** 父节点路径;根为 "."(或 "/root")。 */
  parentPath: string;
  /** 节点类型(ClassDB 类名);本层仅做静态写法校验,不查 ClassDB。 */
  nodeType: string;
  /** 新节点名。 */
  nodeName: string;
  /** 段体属性(name / value 原文);属性名不得是 `[node]` 段头字段。 */
  properties?: ReadonlyArray<{ name: string; value: string }>;
  /** 父节点下已存在同名节点时:true 自动追加数字后缀,false(默认)报错。 */
  autoRename?: boolean;
}

/** scene_add_node 创建出来的节点(静态视图:就是写进文件的那些字段)。 */
export interface CreatedNode {
  /** 新节点最终路径(autoRename 触发时与请求名不同)。 */
  nodePath: string;
  type: string;
  /** `parent=` 字段的值:根的直接子节点为 "."。 */
  parent: string;
  /** 创建时写入段体的属性(name → Literal;同名属性以最后一个为准)。 */
  properties: Record<string, Literal>;
}

export interface AddNodeResult {
  /** 无损序列化后的新文本。 */
  text: string;
  /** 新节点最终路径(autoRename 触发时与请求名不同)。 */
  nodePath: string;
  name: string;
  /** 本次创建写入的信息(文件静态值)。 */
  created: CreatedNode;
}

/** scene_update_node_property 的一次改动(静态前后值)。 */
export interface UpdateNodePropertyResult {
  text: string;
  change: LiteralChange;
}

/** scene_remove_node 删掉的子树。 */
export interface RemovedNodes {
  /** 被删子树里的全部节点路径(按文件顺序,含被删节点自身)。 */
  nodePaths: string[];
  count: number;
}

export interface RemoveNodeResult {
  text: string;
  removed: RemovedNodes;
}

/** scene_reparent_node 的位移摘要。 */
export interface MovedNode {
  /** 移动前的节点路径(归一化,如 `Holder`)。 */
  from: string;
  /** 移动后的节点路径(如 `Player/Holder`)。 */
  to: string;
  /** 实际被改写的节点数(目标及其子孙);已在目标父节点下时为 0。 */
  count: number;
}

/** scene_reparent_node 的入参。 */
export interface ReparentNodeOptions {
  nodePath: string;
  newParentPath: string;
  /** true 需要引擎计算全局变换,文本级实现不支持(会抛 INVALID_ARGUMENT)。 */
  keepGlobalTransform?: boolean;
}

export interface ReparentNodeResult {
  text: string;
  /** 移动后的新路径。 */
  nodePath: string;
  /** 实际被改写的节点数(目标及其子孙)。 */
  movedNodes: number;
  /** 本次位移的 from/to/count 摘要(与 nodePath/movedNodes 同源)。 */
  moved: MovedNode;
}

/** 分组写操作的入参(scene_add_to_group / scene_remove_from_group 共用)。 */
export interface GroupOptions {
  nodePath: string;
  group: string;
}

export interface AddToGroupResult {
  text: string;
  /** false = 该节点已在组内(未改动文本)。 */
  added: boolean;
  groups: string[];
}

export interface RemoveFromGroupResult {
  text: string;
  /** false = 该节点本就不在组内(未改动文本)。 */
  removed: boolean;
  groups: string[];
}

/** scene_instantiate_scene 的入参。 */
export interface InstantiateSceneOptions {
  /** 当前场景自身的 res:// 路径(仅用于循环实例化检测)。 */
  sceneResPath: string;
  parentPath: string;
  /** 被实例化的场景路径(res:// 或项目相对路径)。 */
  instanceScenePath: string;
  /** 被实例化场景的根节点类型(读自目标文件);未知时省略 `type=`。 */
  instanceRootType?: string;
  /** 被实例化场景的根节点名(缺省节点名取它)。 */
  instanceRootName?: string;
  nodeName?: string;
}

/** scene_instantiate_scene 放进来的实例节点(静态视图)。 */
export interface InstantiatedScene {
  /** 新实例节点的路径。 */
  nodePath: string;
  /** 被实例化场景的 res:// 路径(与 instancePath 同源)。 */
  scene: string;
}

export interface InstantiateSceneResult {
  text: string;
  nodePath: string;
  name: string;
  /** 写入/复用的 ext_resource id。 */
  instanceId: string;
  /** 归一化后的 res:// 路径。 */
  instancePath: string;
  /** 本次实例化的节点与来源场景。 */
  instantiated: InstantiatedScene;
}

/** scene_connect_signal / scene_disconnect_signal 的入参。 */
export interface ConnectSignalOptions {
  sourcePath: string;
  signal: string;
  targetPath: string;
  method: string;
  /** 位掩码:CONNECT_DEFERRED=1 / CONNECT_PERSIST=2 / CONNECT_ONE_SHOT=4;0 或缺省时不写 `flags=`。 */
  flags?: number;
}

export interface ConnectSignalResult {
  text: string;
  /** 落盘的 flags(缺省 0)。 */
  flags: number;
}

export interface DisconnectSignalResult {
  text: string;
  /** false = 没有匹配的连接(未改动文本)。 */
  removed: boolean;
}

export interface UpdateSignalConnectionOptions {
  sourcePath: string; signal: string; targetPath: string; method: string;
  newSourcePath?: string; newSignal?: string; newTargetPath?: string; newMethod?: string; flags?: number;
}
export interface UpdateSignalConnectionResult { text: string; updated: boolean; connection?: SceneConnection }

export class SceneService {
  /** Find nodes without making callers transfer or post-process the full tree. */
  findNodes(tscnText: string, options: SceneFindOptions): { nodes: SceneNode[]; total: number; truncated: boolean } {
    const tree = this.getSceneTree(tscnText);
    const pathPrefix = options.pathPrefix?.replace(/^\/root\/?/, "").replace(/^\.?\//, "");
    const nodePath = options.nodePath === undefined ? undefined : normalizeNodePath(options.nodePath, "nodePath");
    const matches = tree.nodes.filter((node) => {
      if (options.name !== undefined && node.name !== options.name) return false;
      if (options.type !== undefined && node.type !== options.type) return false;
      if (pathPrefix !== undefined && !(node.path === pathPrefix || node.path.startsWith(`${pathPrefix}/`))) return false;
      if (options.group !== undefined && !node.groups.includes(options.group)) return false;
      if (options.script !== undefined && node.script !== options.script) return false;
      if (options.isInstance !== undefined && node.isInstance !== options.isInstance) return false;
      if (nodePath !== undefined && (options.includeSubtree === true
        ? !(node.path === nodePath || node.path.startsWith(`${nodePath}/`))
        : node.path !== nodePath)) return false;
      if (options.typeCategory !== undefined && !matchesTypeCategory(node.type, options.typeCategory)) return false;
      return true;
    });
    const maxResults = options.maxResults ?? 100;
    return { nodes: matches.slice(0, maxResults), total: matches.length, truncated: matches.length > maxResults };
  }

  /**
   * 提取结构化场景视图:节点树(名称/类型/Path/父节点/脚本/分组/属性/实例)+ `[connection]` 列表。
   * 实例节点只报告本文件里的覆盖属性,不展开子场景内部节点(本读取器不打开其他文件)。
   */
  getSceneTree(tscnText: string): SceneTree {
    const ast = parseGodotResource(tscnText);
    const ext = extResourcePaths(ast);
    const astNodes = getGodotSceneNodes(ast);
    const created: SceneNode[] = [];
    const byPath = new Map<string, SceneNode>();
    let root: SceneNode | undefined;

    for (const astNode of astNodes) {
      const node = toSceneNode(astNode, ext);
      if (byPath.has(node.path)) {
        throw new GodotMcpError("PARSE_ERROR", `场景中存在重复的节点路径: ${node.path}`, { nodePath: node.path });
      }
      byPath.set(node.path, node);
      created.push(node);
      if (astNode.parent === undefined) {
        if (root) {
          throw new GodotMcpError("PARSE_ERROR", `场景存在多个根节点(缺少 parent 的 [node] 段): ${root.name} / ${node.name}`, { nodePath: node.path });
        }
        root = node;
      }
    }

    for (const astNode of astNodes) {
      const node = byPath.get(nodePathOf(astNode.name, astNode.parent));
      if (!node || node === root) continue;
      const rawParent = astNode.parent ?? ROOT;
      const parent = rawParent === ROOT ? root : byPath.get(rawParent);
      if (parent) {
        node.parentPath = parent.path;
        parent.children.push(node);
      } else {
        // 父节点不在本文件(例如父节点来自被实例化的子场景):挂到根下并保留真实 parentPath,不丢节点。
        node.parentPath = rawParent;
        if (root) root.children.push(node);
      }
    }

    const ordered: SceneNode[] = [];
    const seen = new Set<SceneNode>();
    const walk = (n: SceneNode): void => {
      if (seen.has(n)) return;
      seen.add(n);
      ordered.push(n);
      for (const c of n.children) walk(c);
    };
    if (root) walk(root);
    for (const n of created) if (!seen.has(n)) walk(n);
    return { root, nodes: ordered, connections: readConnections(ast) };
  }

  /**
   * 只读:取节点段头里的 `type=` 与实例标记,供写侧工具做 ClassDB 校验。
   * 节点不存在返回 undefined(写侧会用原有错误路径报告)。
   */
  getNodeType(tscnText: string, nodePath: string): { nodePath: string; type?: string; isInstance: boolean } | undefined {
    const ast = parseGodotResource(tscnText);
    const target = normalizeNodePath(nodePath, "nodePath");
    const section = findNodeSection(ast, target);
    if (!section) return undefined;
    const type = attrValue(section, "type");
    return { nodePath: target, ...(type === undefined ? {} : { type }), isInstance: isInstanceSection(section) };
  }

  /** brief 模式:同一棵树只表达一次(嵌套 children),用于降低 token 消耗。 */
  getSceneTreeBrief(tscnText: string): BriefSceneTree {
    const tree = this.getSceneTree(tscnText);
    const toBrief = (node: SceneNode): BriefSceneNode => ({
      name: node.name,
      ...(node.type === undefined ? {} : { type: node.type }),
      ...(node.script === undefined ? {} : { script: node.script }),
      ...(node.isInstance ? { isInstance: true } : {}),
      ...(node.instanceScene === undefined ? {} : { instanceScene: node.instanceScene }),
      ...(node.groups.length === 0 ? {} : { groups: [...node.groups] }),
      ...(node.children.length === 0 ? {} : { children: node.children.map(toBrief) }),
    });
    return {
      ...(tree.root === undefined ? {} : { root: toBrief(tree.root) }),
      connections: tree.connections,
      nodeCount: tree.nodes.length,
    };
  }

  /**
   * 修改(属性已存在)或新增(不存在则在段体末尾、尾随空行之前插入)节点属性。
   * 返回无损序列化后的文本:除目标行/新增行外,其余字节不变。
   *
   * 对**实例节点**(段头带 `instance=` / `instance_placeholder=`)的两条额外校验(T7 功能 4):
   *   1. 只允许写"当前场景文件的覆盖";指向被实例化子场景**内部**的路径直接报错,
   *      本服务是纯文本变换,任何情况下都不会打开/修改原子场景文件;
   *   2. 该属性在**本节点已有覆盖值**且新旧字面量类型都能静态判定、且明显不符时报错,不静默写入。
   *      判据只用字面量文本(不查 ClassDB、不解析 .gd 的 @export 注解,见下 inferLiteralType)。
   */
  updateNodeProperty(tscnText: string, nodePath: string, key: string, value: string): string {
    return this.updateNodePropertyResult(tscnText, nodePath, key, value).text;
  }

  /**
   * 与 updateNodeProperty 完全相同的写入,额外回报结构化前后值。
   * before/after 都是**文件里的静态字面量**(不是引擎布局后的值;Control 的真实位置请用 runtime_inspect_ui,仅 runtime preset 暴露);
   * 属性原本不在文件中时 before 为 null 且 inFile=false,不伪造引擎默认值。
   */
  updateNodePropertyResult(tscnText: string, nodePath: string, key: string, value: string): UpdateNodePropertyResult {
    assertPropertyEntry(key, value);

    const ast = parseGodotResource(tscnText);
    const target = normalizeNodePath(nodePath, "nodePath");
    const section = findNodeSection(ast, target);
    if (!section) {
      const owner = instantiatedAncestorOf(ast, target);
      throw owner ? insideInstanceError(nodePath, target, owner) : missingNodeError(target, nodePath, "nodePath");
    }
    if (isInstanceSection(section)) assertOverrideValueType(ast, section, key, value);
    const entry = section.body.find((e): e is GodotResourceProperty => e.kind === "property" && e.name === key);
    const beforeRaw = entry === undefined ? null : bodyValue(entry);
    if (entry) {
      entry.value = `${separatorOf(entry.value)}${value}`; // 保留原行的 `=` 后空白写法
    } else {
      section.body.splice(insertIndex(section.body), 0, {
        kind: "property",
        name: key,
        prefix: `${key} =`,
        value: ` ${value}`,
        eol: section.headerEol,
      });
    }
    return { text: serializeGodotResource(ast), change: literalChange(key, beforeRaw, value) };
  }

  /** 删除节点及其所有子节点(含各自段头/段体/尾随空行);返回无损序列化后的文本。 */
  removeNode(tscnText: string, nodePath: string): string {
    return this.removeNodeResult(tscnText, nodePath).text;
  }

  /** 与 removeNode 完全相同的删除,额外回报被删子树里的全部节点路径。 */
  removeNodeResult(tscnText: string, nodePath: string): RemoveNodeResult {
    const target = normalizeNodePath(nodePath);
    if (target === ROOT) {
      throw new GodotMcpError("INVALID_ARGUMENT", "不能删除场景根节点(删除后场景没有根)", { nodePath });
    }
    const ast = parseGodotResource(tscnText);
    const doomed = new Set<GodotResourceSection>();
    const nodePaths: string[] = [];
    for (const section of findGodotResourceSections(ast, "node")) {
      const path = nodeSectionPath(section);
      if (path !== undefined && (path === target || path.startsWith(`${target}/`))) {
        doomed.add(section);
        nodePaths.push(path); // 文件顺序即深度优先顺序
      }
    }
    if (doomed.size === 0) {
      throw new GodotMcpError("INVALID_ARGUMENT", `场景中找不到节点: ${nodePath}`, { nodePath, normalized: target });
    }
    ast.sections = ast.sections.filter((s) => !doomed.has(s));
    return { text: serializeGodotResource(ast), removed: { nodePaths, count: nodePaths.length } };
  }

  // ────────────────── 写侧(T6):新增 / 移动 / 分组 / 实例化 / 信号 ──────────────────

  /**
   * 新增节点:在 parentPath 的子树之后插入 `[node ...]` 段(保持文件里的深度优先顺序)。
   * nodeType 只做静态写法校验(合法类名),不查 ClassDB —— 本层不依赖引擎(runtimeRequired:false)。
   */
  addNode(tscnText: string, o: AddNodeOptions): AddNodeResult {
    const type = assertClassName(o.nodeType, "nodeType");
    const requested = assertNodeName(o.nodeName, "nodeName");
    const ast = parseGodotResource(tscnText);
    const parent = normalizeNodePath(o.parentPath, "parentPath");
    requireNodeSection(ast, parent, "parentPath");
    const siblings = childNamesOf(ast, parent);

    let name = requested;
    if (siblings.includes(name)) {
      if (o.autoRename !== true) {
        throw new GodotMcpError("INVALID_ARGUMENT", `父节点下已存在同名节点: ${name}(可传 autoRename=true 自动改名)`, {
          nodeName: requested, parentPath: o.parentPath, siblings,
        });
      }
      name = uniqueSiblingName(requested, siblings);
    }

    const eol = newlineOf(ast);
    const properties = (o.properties ?? []).map((p) => assertPropertyEntry(p.name, p.value));
    const section = renderNodeSection({ name, parentAttr: parent, type, eol, properties });
    ast.sections.splice(subtreeEndIndex(ast, parent) + 1, 0, section);
    return {
      text: serializeGodotResource(ast),
      nodePath: joinNodePath(parent, name),
      name,
      created: {
        nodePath: joinNodePath(parent, name),
        type,
        parent,
        properties: Object.fromEntries(properties.map((p) => [p.name, toLiteral(p.value) ?? { raw: p.value }])),
      },
    };
  }

  /**
   * 移动节点:目标及其全部子孙的 `parent` 路径前缀一并改写,整棵子树段搬到新父节点的子树之后
   * (保持深度优先顺序);段头里已有的 `owner` 若落在被移动的子树内也同步改写。
   */
  reparentNode(tscnText: string, o: ReparentNodeOptions): ReparentNodeResult {
    if (o.keepGlobalTransform === true) {
      throw new GodotMcpError(
        "INVALID_ARGUMENT",
        "keepGlobalTransform=true 需要引擎计算全局变换,文本级实现不支持;请省略或传 false(注意:移动后节点的全局变换可能改变)",
        { param: "keepGlobalTransform" },
      );
    }
    const target = normalizeNodePath(o.nodePath, "nodePath");
    if (target === ROOT) {
      throw new GodotMcpError("INVALID_ARGUMENT", "不能移动场景根节点(根节点没有父节点)", { nodePath: o.nodePath });
    }
    const newParent = normalizeNodePath(o.newParentPath, "newParentPath");
    const ast = parseGodotResource(tscnText);
    const targetSection = requireNodeSection(ast, target, "nodePath");
    if (newParent === target || newParent.startsWith(`${target}/`)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `不能把节点移动到自身或自己的子孙之下: ${target} -> ${newParent}`, {
        param: "newParentPath", nodePath: target, newParentPath: newParent,
      });
    }
    const newParentSection = requireNodeSection(ast, newParent, "newParentPath");
    const name = attrValue(targetSection, "name");
    if (name === undefined) {
      throw new GodotMcpError("PARSE_ERROR", `节点段缺少 name 属性: ${target}`, { nodePath: target });
    }
    const destPath = joinNodePath(newParent, name);
    if (immediateParentOf(targetSection) === newParent) {
      // 已在新父节点下:不改动(否则会把该子树重排到兄弟末尾,产生无意义的 diff)
      return { text: tscnText, nodePath: destPath, movedNodes: 0, moved: { from: target, to: destPath, count: 0 } };
    }

    const subtree = ast.sections.filter((s) => isInNodeSubtree(s, target));
    for (const section of subtree) {
      const parentRaw = attrValue(section, "parent");
      if (parentRaw !== undefined) {
        const next = section === targetSection ? newParent : mapPathPrefix(parentRaw, target, destPath);
        section.headerRaw = setHeaderAttr(section.headerRaw, "parent", quote(next));
      }
      const ownerRaw = attrValue(section, "owner");
      if (ownerRaw !== undefined) {
        const next = mapPathPrefix(ownerRaw, target, destPath);
        if (next !== ownerRaw) section.headerRaw = setHeaderAttr(section.headerRaw, "owner", quote(next));
      }
    }

    const moved = new Set(subtree);
    const rest = ast.sections.filter((s) => !moved.has(s));
    const parentIndex = rest.indexOf(newParentSection);
    let at = parentIndex + 1;
    for (let i = parentIndex + 1; i < rest.length; i++) {
      const s = rest[i]!;
      if (s.tag !== "node") continue;
      const p = nodeSectionPath(s);
      if (p !== undefined && (newParent === ROOT || p.startsWith(`${newParent}/`))) at = i + 1;
    }
    ast.sections = [...rest.slice(0, at), ...subtree, ...rest.slice(at)];
    return {
      text: serializeGodotResource(ast),
      nodePath: destPath,
      movedNodes: subtree.length,
      moved: { from: target, to: destPath, count: subtree.length },
    };
  }

  /** 把节点加入组(已在组内则原样返回,不报错)。 */
  addToGroup(tscnText: string, o: GroupOptions): AddToGroupResult {
    const group = assertGroupName(o.group);
    const ast = parseGodotResource(tscnText);
    const section = requireNodeSection(ast, o.nodePath, "nodePath");
    const groups = groupsOf(section);
    if (groups.includes(group)) return { text: tscnText, added: false, groups };
    const next = [...groups, group];
    section.headerRaw = setHeaderAttr(section.headerRaw, "groups", renderStringArray(next));
    return { text: serializeGodotResource(ast), added: true, groups: next };
  }

  /** 把节点移出组(不在组内则原样返回,不报错);组清空时删除整个 `groups=` 属性。 */
  removeFromGroup(tscnText: string, o: GroupOptions): RemoveFromGroupResult {
    const group = assertGroupName(o.group);
    const ast = parseGodotResource(tscnText);
    const section = requireNodeSection(ast, o.nodePath, "nodePath");
    const groups = groupsOf(section);
    if (!groups.includes(group)) return { text: tscnText, removed: false, groups };
    const next = groups.filter((g) => g !== group);
    section.headerRaw = setHeaderAttr(section.headerRaw, "groups", next.length === 0 ? undefined : renderStringArray(next));
    return { text: serializeGodotResource(ast), removed: true, groups: next };
  }

  /**
   * 实例化子场景:写入 `[ext_resource type="PackedScene" ...]` + `[node ... instance=ExtResource("id")]`,
   * **不展开**子场景的子节点;同 path 的 ext_resource 已存在时复用(引擎同一 path 只写一条)。
   */
  instantiateScene(tscnText: string, o: InstantiateSceneOptions): InstantiateSceneResult {
    const resPath = toResPath(assertNonEmpty(o.instanceScenePath, "instanceScenePath"));
    if (resPath === toResPath(assertNonEmpty(o.sceneResPath, "sceneResPath"))) {
      throw new GodotMcpError("INVALID_ARGUMENT", `不能把场景实例化到自己内部(循环实例化): ${resPath}`, {
        param: "instanceScenePath", scenePath: o.sceneResPath, instanceScenePath: o.instanceScenePath,
      });
    }
    const ast = parseGodotResource(tscnText);
    const parent = normalizeNodePath(o.parentPath, "parentPath");
    requireNodeSection(ast, parent, "parentPath");

    const requested = o.nodeName ?? o.instanceRootName ?? baseNameOf(resPath);
    const name = assertNodeName(requested, o.nodeName === undefined ? "nodeName(缺省取自被实例化场景)" : "nodeName");
    const siblings = childNamesOf(ast, parent);
    if (siblings.includes(name)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `父节点下已存在同名节点: ${name}(实例化不支持自动改名,请传 nodeName)`, {
        nodeName: name, parentPath: o.parentPath, siblings,
      });
    }

    const instanceId = ensurePackedSceneExtResource(ast, resPath);
    const eol = newlineOf(ast);
    const section = renderNodeSection({
      name, parentAttr: parent, type: o.instanceRootType, instanceRef: `ExtResource(${quote(instanceId)})`, eol, properties: [],
    });
    ast.sections.splice(subtreeEndIndex(ast, parent) + 1, 0, section);
    return {
      text: serializeGodotResource(ast),
      nodePath: joinNodePath(parent, name),
      name,
      instanceId,
      instancePath: resPath,
      instantiated: { nodePath: joinNodePath(parent, name), scene: resPath },
    };
  }

  /** 连接信号:写入 `[connection ...]` 段(随场景文件持久化)。同一 source/signal/target/method 重复连接报错。 */
  connectSignal(tscnText: string, o: ConnectSignalOptions): ConnectSignalResult {
    const signal = assertIdentifier(o.signal, "signal");
    const method = assertIdentifier(o.method, "method");
    const flags = assertFlags(o.flags);
    const ast = parseGodotResource(tscnText);
    const from = normalizeNodePath(o.sourcePath, "sourcePath");
    const to = normalizeNodePath(o.targetPath, "targetPath");
    requireNodeSection(ast, from, "sourcePath");
    requireNodeSection(ast, to, "targetPath");
    if (findConnection(ast, signal, from, to, method)) {
      throw new GodotMcpError("INVALID_ARGUMENT", `连接已存在(重复连接): ${describeConnection(signal, from, to, method)}`, {
        signal, from, to, method,
      });
    }
    const eol = newlineOf(ast);
    // flags 落盘规则 —— 4.6.3 实测(见 tests/sceneWriteTools.real.test.ts):
    //   加载 .tscn 的 [connection] 时引擎会并上 CONNECT_PERSIST(2)|CONNECT_INHERITED(32);
    //   引擎保存时 f = flags & ~32,且仅当 f & ~2 != 0 才写出 `flags=f`。
    // 按同一规则落盘(先并上隐含的 PERSIST,再看除 PERSIST 外是否还有位),我们写出的文本
    // 就是引擎 save 的不动点;PERSIST 是 .tscn 连接的隐含义,不必也不该由调用方显式提供。
    const persisted = flags | CONNECT_PERSIST;
    const written = (persisted & ~CONNECT_PERSIST) !== 0 ? persisted : 0;
    const attributes: GodotResourceAttribute[] = [
      { name: "signal", value: quote(signal) },
      { name: "from", value: quote(from) },
      { name: "to", value: quote(to) },
      { name: "method", value: quote(method) },
      ...(written === 0 ? [] : [{ name: "flags", value: String(written) }]),
    ];
    ast.sections.splice(connectionInsertIndex(ast), 0, {
      kind: "section",
      tag: "connection",
      tagName: "connection",
      headerRaw: headerLine("connection", attributes),
      headerEol: eol,
      attributes,
      // 连接的段体为空:4.6.3 引擎写出的 connection 段之间没有空行(节点段才有)
      body: [],
    });
    const text = serializeGodotResource(ast);
    const persistedConnection = readConnections(parseGodotResource(text)).find((c) =>
      c.signal === signal && c.source === from && c.target === to && c.method === method,
    );
    if (!persistedConnection) {
      throw new GodotMcpError("VALIDATION_FAILED", "连接写入后重新解析失败", { signal, from, to, method });
    }
    return { text, flags: written };
  }

  /** 断开信号:删除匹配的 `[connection ...]` 段;没有该连接时原样返回(removed=false,不报错)。 */
  disconnectSignal(tscnText: string, o: ConnectSignalOptions): DisconnectSignalResult {
    const signal = assertIdentifier(o.signal, "signal");
    const method = assertIdentifier(o.method, "method");
    const ast = parseGodotResource(tscnText);
    const from = normalizeNodePath(o.sourcePath, "sourcePath");
    const to = normalizeNodePath(o.targetPath, "targetPath");
    const matches = findConnectionSections(ast, signal, from, to, method);
    if (matches.length === 0) return { text: tscnText, removed: false };
    if (matches.length > 1) {
      throw new GodotMcpError("INVALID_ARGUMENT", "目标连接不唯一，拒绝删除", {
        count: matches.length, signal, from, to, method,
      });
    }
    const doomed = matches[0]!;
    ast.sections = ast.sections.filter((s) => s !== doomed);
    const text = serializeGodotResource(ast);
    const remaining = readConnections(parseGodotResource(text)).some((c) =>
      c.signal === signal && c.source === from && c.target === to && c.method === method,
    );
    if (remaining) {
      throw new GodotMcpError("VALIDATION_FAILED", "连接删除后重新解析仍存在目标连接", { signal, from, to, method });
    }
    return { text, removed: true };
  }

  /** 精确更新一条持久化连接，保留目标段头中的未修改/未知属性，不通过删除再创建实现。 */
  updateSignalConnection(tscnText: string, o: UpdateSignalConnectionOptions): UpdateSignalConnectionResult {
    const oldSignal = assertIdentifier(o.signal, "signal");
    const oldMethod = assertIdentifier(o.method, "method");
    const ast = parseGodotResource(tscnText);
    const from = normalizeNodePath(o.sourcePath, "sourcePath");
    const to = normalizeNodePath(o.targetPath, "targetPath");
    const matches = findConnectionSections(ast, oldSignal, from, to, oldMethod);
    if (matches.length === 0) throw new GodotMcpError("INVALID_ARGUMENT", "找不到要更新的连接", { signal: oldSignal, from, to, method: oldMethod });
    if (matches.length > 1) throw new GodotMcpError("INVALID_ARGUMENT", "目标连接不唯一，拒绝更新", { count: matches.length, signal: oldSignal, from, to, method: oldMethod });
    if (o.newSourcePath === undefined && o.newSignal === undefined && o.newTargetPath === undefined && o.newMethod === undefined && o.flags === undefined) {
      throw new GodotMcpError("INVALID_ARGUMENT", "至少需要提供一个 new* 字段或 flags", { param: "update" });
    }
    const section = matches[0]!;
    const nextFrom = o.newSourcePath === undefined ? from : normalizeNodePath(o.newSourcePath, "newSourcePath");
    const nextTo = o.newTargetPath === undefined ? to : normalizeNodePath(o.newTargetPath, "newTargetPath");
    requireNodeSection(ast, nextFrom, "newSourcePath"); requireNodeSection(ast, nextTo, "newTargetPath");
    const nextSignal = o.newSignal === undefined ? oldSignal : assertIdentifier(o.newSignal, "newSignal");
    const nextMethod = o.newMethod === undefined ? oldMethod : assertIdentifier(o.newMethod, "newMethod");
    const duplicate = findConnectionSections(ast, nextSignal, nextFrom, nextTo, nextMethod).filter((s) => s !== section);
    if (duplicate.length > 0) throw new GodotMcpError("INVALID_ARGUMENT", "更新后会产生重复连接", { signal: nextSignal, from: nextFrom, to: nextTo, method: nextMethod });
    const attrs = section.attributes.map((a) => ({ ...a }));
    setConnectionHeaderAttr(attrs, "signal", quote(nextSignal)); setConnectionHeaderAttr(attrs, "from", quote(nextFrom)); setConnectionHeaderAttr(attrs, "to", quote(nextTo)); setConnectionHeaderAttr(attrs, "method", quote(nextMethod));
    if (o.flags !== undefined) {
      const flags = assertFlags(o.flags); const persisted = flags | CONNECT_PERSIST; const written = (persisted & ~CONNECT_PERSIST) !== 0 ? persisted : 0;
      if (written === 0) removeConnectionHeaderAttr(attrs, "flags"); else setConnectionHeaderAttr(attrs, "flags", String(written));
    }
    section.attributes = attrs; section.headerRaw = headerLine(section.tagName, attrs);
    const parsed = readConnections(ast).find((c) => c.source === nextFrom && c.signal === nextSignal && c.target === nextTo && c.method === nextMethod);
    if (!parsed) throw new GodotMcpError("VALIDATION_FAILED", "连接更新后重新解析失败", { signal: nextSignal, from: nextFrom, to: nextTo, method: nextMethod });
    return { text: serializeGodotResource(ast), updated: true, connection: parsed };
  }
}

function matchesTypeCategory(type: string | undefined, category: NonNullable<SceneFindOptions["typeCategory"]>): boolean {
  if (type === undefined) return false;
  if (category === "container") return type === "Container" || type.endsWith("Container");
  if (category === "control") return type === "Control" || type === "Container" || type.endsWith("Container") || ["Button", "CheckBox", "Label", "LineEdit", "TextEdit", "TextureRect", "Panel", "ColorRect", "ProgressBar", "ScrollBar", "Slider"].includes(type);
  if (category === "node2d") return type === "Node2D" || type.endsWith("2D") || ["Sprite2D", "AnimatedSprite2D", "Camera2D", "TileMap", "TileMapLayer", "Area2D", "CharacterBody2D", "RigidBody2D", "StaticBody2D"].includes(type);
  return type === "Node" || type.endsWith("2D") || type.endsWith("3D") || type.endsWith("Container") || ["Timer", "AnimationPlayer", "Area2D", "CharacterBody2D", "RigidBody2D", "StaticBody2D"].includes(type);
}

// ────────────────────────────── 内部工具 ──────────────────────────────

/** 规范化节点路径:根为 ".",其余为相对场景根的 `/` 分隔路径。接受 ".", "/root", "/root/A/B", "A/B", "./A"。 */
function normalizeNodePath(input: string, param = "nodePath"): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 不能为空`, { param, value: input });
  }
  let p = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (p === "root") return ROOT;
  if (p.startsWith("root/")) p = p.slice("root/".length);
  p = p.replace(/^\.\//, "").replace(/\/+$/, "");
  return p === "" || p === ROOT ? ROOT : p;
}

/** Godot 的 `parent` 字段语义:无 parent 为场景根;`parent="."` 是根的直接子节点,其余相对场景根。 */
function nodePathOf(name: string, parent: string | undefined): string {
  if (parent === undefined) return ROOT;
  return parent === ROOT ? name : `${parent}/${name}`;
}

function nodeSectionPath(section: GodotResourceSection): string | undefined {
  const name = attrValue(section, "name");
  return name === undefined ? undefined : nodePathOf(name, attrValue(section, "parent"));
}

/** 段的直接父节点路径;undefined 表示该段是场景根节点(无 `parent` 属性)。 */
function immediateParentOf(section: GodotResourceSection): string | undefined {
  return attrValue(section, "parent");
}

function joinNodePath(parent: string, name: string): string {
  return parent === ROOT ? name : `${parent}/${name}`;
}

/** 按规范路径找节点段(不抛错);path 需已 normalizeNodePath。 */
function findNodeSection(ast: GodotResourceAST, path: string): GodotResourceSection | undefined {
  for (const section of findGodotResourceSections(ast, "node")) {
    if (nodeSectionPath(section) === path) return section;
  }
  return undefined;
}

/** 按路径取节点段;不存在(或没有根节点)抛 INVALID_ARGUMENT,并注明是哪个参数错的。 */
function requireNodeSection(ast: GodotResourceAST, path: string, param: string): GodotResourceSection {
  const target = normalizeNodePath(path, param);
  const section = findNodeSection(ast, target);
  if (section) return section;
  throw missingNodeError(target, path, param);
}

/** "节点不存在/没有根节点"的统一错误(带是哪个参数错的);调用方可能给出更准确的原因(如实例内部)。 */
function missingNodeError(target: string, input: string, param: string): GodotMcpError {
  if (target === ROOT) {
    return new GodotMcpError("INVALID_ARGUMENT", `场景没有根节点(缺少不带 parent 的 [node] 段): ${param}`, { param, nodePath: input });
  }
  return new GodotMcpError("INVALID_ARGUMENT", `${param} 指向的节点不存在: ${input}`, { param, nodePath: input, normalized: target });
}

function isInNodeSubtree(section: GodotResourceSection, rootPath: string): boolean {
  if (section.tag !== "node") return false;
  const p = nodeSectionPath(section);
  return p !== undefined && (p === rootPath || p.startsWith(`${rootPath}/`));
}

/** parent 子树里最后一个节点段的索引(parent 自身也算);找不到返回 -1。 */
function subtreeEndIndex(ast: GodotResourceAST, parent: string): number {
  let at = -1;
  ast.sections.forEach((section, i) => {
    if (section.tag !== "node") return;
    const p = nodeSectionPath(section);
    if (p === undefined) return;
    if (parent === ROOT || p === parent || p.startsWith(`${parent}/`)) at = i;
  });
  return at;
}

/** parent 下直接子节点的名字列表。 */
function childNamesOf(ast: GodotResourceAST, parent: string): string[] {
  const out: string[] = [];
  for (const section of findGodotResourceSections(ast, "node")) {
    if (immediateParentOf(section) !== parent) continue;
    const name = attrValue(section, "name");
    if (name !== undefined) out.push(name);
  }
  return out;
}

/** 重名时的自动改名:追加数字后缀。写法未经 4.6.3 实测,只保证同父不重名。 */
function uniqueSiblingName(base: string, taken: readonly string[]): string {
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** 路径前缀改写:`from` → `to`,`from/...` → `to/...`,其余原样。 */
function mapPathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

function newlineOf(ast: GodotResourceAST): GodotLineEnding {
  return ast.newline as GodotLineEnding;
}

/** 由属性列表渲染段头行 `[tag a=b c=d]`(值需已渲染好)。 */
function headerLine(tag: string, attributes: readonly GodotResourceAttribute[]): string {
  return `[${tag}${attributes.map((a) => ` ${a.name}=${a.value}`).join("")}]`;
}
function setConnectionHeaderAttr(attrs: GodotResourceAttribute[], name: string, value: string): void { const found = attrs.find((a) => a.name === name); if (found) found.value = value; else attrs.push({ name, value }); }
function removeConnectionHeaderAttr(attrs: GodotResourceAttribute[], name: string): void { const i = attrs.findIndex((a) => a.name === name); if (i >= 0) attrs.splice(i, 1); }

/** 新 `[node]` 段的渲染参数。 */
interface NewNodeSectionOptions {
  name: string;
  /** `parent=` 的值:根的直接子节点为 "."。 */
  parentAttr: string;
  type?: string;
  /** `instance=ExtResource("id")` 的原文(实例化节点用);不展开子场景。 */
  instanceRef?: string;
  properties: ReadonlyArray<{ name: string; value: string }>;
  eol: GodotLineEnding;
}

/** 渲染 `[node ...]` 段(段体属性 + 尾随空行)。 */
function renderNodeSection(o: NewNodeSectionOptions): GodotResourceSection {
  const attributes: GodotResourceAttribute[] = [
    { name: "name", value: quote(o.name) },
    ...(o.type === undefined ? [] : [{ name: "type", value: quote(o.type) }]),
    { name: "parent", value: quote(o.parentAttr) },
    ...(o.instanceRef === undefined ? [] : [{ name: "instance", value: o.instanceRef }]),
  ];
  const body: GodotResourceBodyEntry[] = o.properties.map((p) => ({
    kind: "property", name: p.name, prefix: `${p.name} =`, value: ` ${p.value}`, eol: o.eol,
  }));
  body.push({ kind: "blank", raw: "", eol: o.eol });
  return {
    kind: "section",
    tag: "node",
    tagName: "node",
    headerRaw: headerLine("node", attributes),
    headerEol: o.eol,
    attributes,
    body,
  };
}

/** 节点名合法性:非空、无首尾空白、不含 Godot 保留字符(`Node::set_name` 禁止 `. / : @ %`)。 */
function assertNodeName(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 不能为空`, { param, value });
  }
  if (value !== value.trim()) {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 不得有首尾空白: ${JSON.stringify(value)}`, { param, value });
  }
  if (/[./:@%"\\\n\r\0]/.test(value)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 含非法字符(不得含 . / : @ % " 或反斜杠): ${JSON.stringify(value)}`, { param, value });
  }
  return value;
}

/**
 * 节点类型的**静态**校验:只检查写法像合法类名(标识符),不查 ClassDB。
 * 「是否是可实例化的 Node 派生类」需要引擎,留给后续 runtime 类工具;此处不猜。
 */
function assertClassName(value: unknown, param: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_]\w*$/.test(value)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 必须是合法的 Godot 类名(标识符): ${JSON.stringify(value)}(仅静态校验,未查 ClassDB)`, { param, value });
  }
  return value;
}

/** 信号名 / 方法名的静态校验(Godot 标识符)。 */
function assertIdentifier(value: unknown, param: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_]\w*$/.test(value)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 必须是合法的 Godot 标识符: ${JSON.stringify(value)}`, { param, value });
  }
  return value;
}

/** `Object.CONNECT_PERSIST`:连接写进 .tscn 的隐含义,由本服务补上而不是要求调用方传。 */
const CONNECT_PERSIST = 2;

/** flags 位掩码:CONNECT_DEFERRED=1 / CONNECT_PERSIST=2 / CONNECT_ONE_SHOT=4。 */
function assertFlags(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new GodotMcpError("INVALID_ARGUMENT", `flags 必须是非负整数位掩码(DEFERRED=1, PERSIST=2, ONE_SHOT=4): ${JSON.stringify(value)}`, { param: "flags", value });
  }
  return value;
}

/** 组名:非空、无首尾空白、不含换行(引号与反斜杠会被转义)。 */
function assertGroupName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", "group 不能为空", { param: "group", value });
  }
  if (value !== value.trim() || /[\n\r\0]/.test(value)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `group 不得有首尾空白或换行: ${JSON.stringify(value)}`, { param: "group", value });
  }
  return value;
}

function assertNonEmpty(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `${param} 不能为空`, { param, value });
  }
  return value.trim();
}

/** 渲染为段头字符串字面量(转义 `\` 与 `"`)。 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 段头行内一个属性的区间:nameStart 是属性名起点,start/end 是值 token 的区间。 */
interface HeaderAttrSpan { name: string; nameStart: number; start: number; end: number }

/** 段头行内的全部 `name=value` 区间;无法定位段头时 close 为 -1。 */
function headerAttrSpans(headerRaw: string): { spans: HeaderAttrSpan[]; close: number } {
  const open = headerRaw.indexOf("[");
  if (open < 0) return { spans: [], close: -1 };
  const close = findHeaderEnd(headerRaw, open);
  if (close < 0) return { spans: [], close: -1 };

  const spans: HeaderAttrSpan[] = [];
  let i = skipSpace(headerRaw, open + 1);
  while (i < close && !/[\s=]/.test(headerRaw.charAt(i))) i++; // 跳过 tag
  i = skipSpace(headerRaw, i);
  while (i < close) {
    const nameStart = i;
    while (i < close && !/[\s=]/.test(headerRaw.charAt(i))) i++;
    const name = headerRaw.slice(nameStart, i);
    i = skipSpace(headerRaw, i);
    if (name === "" || headerRaw.charAt(i) !== "=") {
      if (i <= nameStart) i++;
      continue;
    }
    i = skipSpace(headerRaw, i + 1);
    const valueStart = i;
    i = scanHeaderValueEnd(headerRaw, i, close);
    if (i > valueStart) spans.push({ name, nameStart, start: valueStart, end: i });
    i = skipSpace(headerRaw, i);
  }
  return { spans, close };
}

/** 段头里一个属性值的结束位置:字符串到闭引号、括号块到配对闭合、裸值到空白。 */
function scanHeaderValueEnd(text: string, from: number, limit: number): number {
  const first = text.charAt(from);
  if (first === '"') {
    let i = from + 1;
    while (i < limit) {
      const c = text.charAt(i);
      if (c === "\\") i += 2;
      else if (c === '"') return i + 1;
      else i++;
    }
    return limit;
  }
  if (first === "[" || first === "{" || first === "(") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = from; i < limit; i++) {
      const c = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "[" || c === "{" || c === "(") depth++;
      else if (c === "]" || c === "}" || c === ")") { depth--; if (depth === 0) return i + 1; }
    }
    return limit;
  }
  let i = from;
  while (i < limit && !/\s/.test(text.charAt(i))) i++;
  return i;
}

/**
 * 改写段头里的单个属性:renderedValue 传 undefined 表示删除该属性,
 * 传字符串表示设置(调用方负责已渲染:字符串需自带引号)。其余字节逐字节保留。
 */
function setHeaderAttr(headerRaw: string, name: string, renderedValue: string | undefined): string {
  const { spans, close } = headerAttrSpans(headerRaw);
  if (close < 0) return headerRaw; // 防御:该行来自已识别的段,不该发生
  const target = spans.find((s) => s.name === name);
  if (renderedValue === undefined) {
    if (!target) return headerRaw;
    // 删除整个 `name=value`(含属性名前的空白),只留值会把 `name=` 变成孤儿
    let from = target.nameStart;
    while (from > 0 && /[ \t]/.test(headerRaw.charAt(from - 1))) from--;
    return headerRaw.slice(0, from) + headerRaw.slice(target.end);
  }
  if (target) return headerRaw.slice(0, target.start) + renderedValue + headerRaw.slice(target.end);
  return headerRaw.slice(0, close) + ` ${name}=${renderedValue}` + headerRaw.slice(close);
}

/** 节点当前的组列表(与 getGodotSceneNodes 相同的解析规则)。 */
function groupsOf(section: GodotResourceSection): string[] {
  const raw = section.attributes.find((a) => a.name === "groups")?.value;
  return raw === undefined ? [] : splitArrayElements(raw).map(unquote);
}

/** Godot Array 的单行写法 `["a", "b"]`;`groups=` 的真实样例本仓库暂无,分隔符未经 4.6.3 实测。 */
function renderStringArray(values: readonly string[]): string {
  return `[${values.map(quote).join(", ")}]`;
}

/** 归一化为 `res://` 形式(纯字符串处理,不解析项目根,也不查文件系统)。 */
function toResPath(path: string): string {
  const rel = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^res:\/\//, "")
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  return `res://${rel}`;
}

/** `res://scenes/child.tscn` → `child`(缺省节点名兜底用)。 */
function baseNameOf(resPath: string): string {
  const file = resPath.slice(resPath.lastIndexOf("/") + 1);
  return file.replace(/\.[^.]*$/, "") || file;
}

/** 新 ext_resource 的插入位置:最后一个 ext_resource 之后;没有则紧跟 gd_scene/gd_resource 头段之后。 */
function extInsertIndex(ast: GodotResourceAST): number {
  const header = ast.sections.findIndex((s) => s.tag === "gd_scene" || s.tag === "gd_resource");
  let at = header < 0 ? 0 : header + 1;
  for (let i = at; i < ast.sections.length; i++) {
    if (ast.sections[i]!.tag === "ext_resource") at = i + 1;
  }
  return at;
}

/** 新 ext_resource 的 id:形如 `2_mcp`;引擎只把它当 key(命名风格未经 4.6.3 实测)。 */
function uniqueExtId(ast: GodotResourceAST): string {
  const used = new Set(
    findGodotResourceSections(ast, "ext_resource")
      .map((s) => attrValue(s, "id"))
      .filter((v): v is string => v !== undefined),
  );
  for (let n = used.size + 1; ; n++) {
    const id = `${n}_mcp`;
    if (!used.has(id)) return id;
  }
}

/**
 * 取/建 PackedScene 的 ext_resource:同 path 已存在则复用其 id(引擎同一 path 只写一条)。
 * 不写 `uid=`:4.6.3 运行时 ResourceSaver 也不写(见 tests/fixtures/SOURCE.md),引擎按 path 解析。
 */
function ensurePackedSceneExtResource(ast: GodotResourceAST, resPath: string): string {
  for (const section of findGodotResourceSections(ast, "ext_resource")) {
    const id = attrValue(section, "id");
    const path = attrValue(section, "path");
    if (id !== undefined && path !== undefined && toResPath(path) === resPath) return id;
  }
  const id = uniqueExtId(ast);
  const eol = newlineOf(ast);
  const attributes: GodotResourceAttribute[] = [
    { name: "type", value: quote("PackedScene") },
    { name: "path", value: quote(resPath) },
    { name: "id", value: quote(id) },
  ];
  insertSectionAfterTrailingBlanks(ast, extInsertIndex(ast), {
    kind: "section",
    tag: "ext_resource",
    tagName: "ext_resource",
    headerRaw: headerLine("ext_resource", attributes),
    headerEol: eol,
    attributes,
    body: [{ kind: "blank", raw: "", eol }],
  });
  return id;
}

/**
 * 在 index 处插入段落,并把前一段的尾随空行挪到新段之后。
 * 否则 ext_resource 块会被自身尾随空行从中间断开(实测 4.6.3:引擎写出的 ext_resource 块是连续的),
 * 空行总数不变,只是位置后移到新段之后。
 */
function insertSectionAfterTrailingBlanks(ast: GodotResourceAST, index: number, section: GodotResourceSection): void {
  const prev = ast.sections[index - 1];
  const moved: GodotResourceBodyEntry[] = [];
  while (prev && prev.body.length > 0 && prev.body[prev.body.length - 1]!.kind === "blank") {
    moved.unshift(prev.body.pop()!);
  }
  if (moved.length > 0) section.body = moved;
  ast.sections.splice(index, 0, section);
}

/** 匹配 signal/from/to/method 四要素的连接段;没有则 undefined。 */
function findConnection(
  ast: GodotResourceAST, signal: string, from: string, to: string, method: string,
): GodotResourceSection | undefined {
  return findGodotResourceSections(ast, "connection").find(
    (s) => attrValue(s, "signal") === signal && attrValue(s, "from") === from
      && attrValue(s, "to") === to && attrValue(s, "method") === method,
  );
}
function findConnectionSections(ast: GodotResourceAST, signal: string, from: string, to: string, method: string): GodotResourceSection[] {
  return findGodotResourceSections(ast, "connection").filter((s) => attrValue(s, "signal") === signal && attrValue(s, "from") === from && attrValue(s, "to") === to && attrValue(s, "method") === method);
}

function describeConnection(signal: string, from: string, to: string, method: string): string {
  return `${from === ROOT ? "场景根" : from}.${signal} -> ${to === ROOT ? "场景根" : to}.${method}`;
}

/** 新 connection 的插入位置:最后一个 connection/node 段之后,但不越过 `[editable]` 段。 */
function connectionInsertIndex(ast: GodotResourceAST): number {
  const header = ast.sections.findIndex((s) => s.tag === "gd_scene" || s.tag === "gd_resource");
  let at = header < 0 ? 0 : header + 1;
  for (let i = at; i < ast.sections.length; i++) {
    const tag = ast.sections[i]!.tag;
    if (tag === "editable") break;
    if (tag === "ext_resource" || tag === "sub_resource" || tag === "node" || tag === "connection") at = i + 1;
  }
  return at;
}

function toSceneNode(n: GodotNodeAST, ext: Map<string, string>): SceneNode {
  const properties = n.properties.map((p) => ({ name: p.name, value: bodyValue(p) }));
  const instanceScene = instanceSceneOf(n, ext);
  const node: SceneNode = {
    name: n.name,
    path: nodePathOf(n.name, n.parent),
    properties,
    groups: [...n.groups],
    children: [],
    // 子场景实例:有 instance= 或 instance_placeholder= 即算;两种情况都不展开子场景内部节点
    isInstance: n.instance !== undefined || n.instancePlaceholder !== undefined,
  };
  if (n.type !== undefined) node.type = n.type;
  if (n.uniqueId !== undefined) node.uniqueId = n.uniqueId;
  if (n.instance !== undefined) node.instance = instanceScene ?? n.instance;
  if (instanceScene !== undefined) node.instanceScene = instanceScene;
  // 实例节点的段体属性全部是"当前场景文件的覆盖"(含 script);非实例节点不出现该字段
  if (node.isInstance) node.overrides = properties.map((p) => ({ name: p.name, value: p.value }));
  const script = n.properties.find((p) => p.name === "script");
  if (script) {
    const raw = bodyValue(script);
    node.script = resolveExtRef(raw, ext) ?? raw;
  }
  return node;
}

/** 段体属性值:`name = value` 中 `=` 之后的原文(含分隔空白),读取时去掉一个分隔空白。 */
function bodyValue(property: GodotResourceProperty): string {
  return property.value.replace(/^[ \t]/, "");
}

function separatorOf(raw: string): string {
  return /^[ \t]*/.exec(raw)?.[0] ?? "";
}

/** 新属性插入点:最后一个非空行之后(尾随空行留到段尾)。 */
function insertIndex(body: GodotResourceSection["body"]): number {
  let at = 0;
  for (let i = 0; i < body.length; i++) if (body[i]!.kind !== "blank") at = i + 1;
  return at;
}

/** 段体属性名校验:非空、不含空白/`=`、不是 `[node]` 段头字段。 */
function assertPropertyName(key: unknown): string {
  if (typeof key !== "string" || key.trim() === "" || /[\s=]/.test(key)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `属性名非法(不得含空白或 '='): ${JSON.stringify(key)}`, { key });
  }
  if (NODE_HEADER_ATTRS.has(key)) {
    throw new GodotMcpError("INVALID_ARGUMENT", `"${key}" 是节点段头字段,不能作为段体属性写入`, { key });
  }
  return key;
}

/** 段体属性名校验 + 值校验;用于写入前的统一把关。 */
function assertPropertyEntry(key: unknown, value: string): { name: string; value: string } {
  const name = assertPropertyName(key);
  assertValidValue(name, value);
  return { name, value };
}

/** 写入前校验:值必须是括号/引号平衡的完整 Godot 表达式,否则拒绝(不产出损坏文件)。 */
function assertValidValue(key: string, value: string): void {
  if (value.trim() === "") {
    throw new GodotMcpError("INVALID_ARGUMENT", `属性值不能为空: ${key}`, { key, value });
  }
  const balance = scanBalance(value, 0);
  if (balance.depth !== 0 || balance.inString) {
    throw new GodotMcpError("INVALID_ARGUMENT", `属性值不是合法的 Godot 表达式(括号或引号不平衡): ${key}`, { key, value });
  }
}

/** 段头字段取值(去引号 / 反转义);裸值(如 `format=3`)原样返回。 */
function attrValue(section: GodotResourceSection, name: string): string | undefined {
  const raw = section.attributes.find((a) => a.name === name)?.value;
  return raw === undefined ? undefined : decodeQuoted(raw);
}

/** `id` → `path` 映射,用于把 `ExtResource("1_script")` 解析成 `res://…`。 */
function extResourcePaths(ast: GodotResourceAST): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of findGodotResourceSections(ast, "ext_resource")) {
    const id = attrValue(section, "id");
    const path = attrValue(section, "path");
    if (id !== undefined && id !== "" && path !== undefined) map.set(id, path);
  }
  return map;
}

const EXT_REF = /ExtResource\(\s*("(?:[^"\\]|\\.)*")\s*\)/;

function resolveExtRef(raw: string | undefined, ext: Map<string, string>): string | undefined {
  const id = raw === undefined ? undefined : EXT_REF.exec(raw)?.[1];
  return id === undefined ? undefined : ext.get(decodeQuoted(id));
}

/** 去掉成对引号并反转义(与解析器的 unquote 同规则;此处仅用于段头/id 这类短文本)。 */
function decodeQuoted(raw: string): string {
  const t = raw.trim();
  if (t.length < 2 || t.charAt(0) !== '"' || t.charAt(t.length - 1) !== '"') return t;
  return t.slice(1, -1).replace(/\\(.)/g, "$1");
}

// ══════════════════ T7:读侧(connections / 实例节点)与实例覆盖校验 ══════════════════

/**
 * 4.6.3 实测的 `Object.ConnectFlags`(取自 `godot --headless --dump-extension-api` 的
 * `Object.enums.ConnectFlags`):DEFERRED=1 / PERSIST=2 / ONE_SHOT=4 / REFERENCE_COUNTED=8 /
 * APPEND_SOURCE_OBJECT=16。引擎在**加载** .tscn 时额外并入的 `CONNECT_INHERITED(32)`
 * 不在此表里 —— 它不是文件里会出现的写法(引擎保存时按 `f = flags & ~32` 剥离)。
 */
const CONNECT_FLAG_NAMES: ReadonlyArray<readonly [number, string]> = [
  [1, "DEFERRED"], [2, "PERSIST"], [4, "ONE_SHOT"], [8, "REFERENCE_COUNTED"], [16, "APPEND_SOURCE_OBJECT"],
];

/** 文件里的全部 `[connection]` 段;必填字段缺失或 flags 不是 32 位非负整数时抛 PARSE_ERROR(不静默丢连接)。 */
function readConnections(ast: GodotResourceAST): SceneConnection[] {
  return findGodotResourceSections(ast, "connection").map((section) => {
    const source = attrValue(section, "from");
    const signal = attrValue(section, "signal");
    const target = attrValue(section, "to");
    const method = attrValue(section, "method");
    if (source === undefined || signal === undefined || target === undefined || method === undefined) {
      throw new GodotMcpError("PARSE_ERROR", `[connection] 段缺少 signal/from/to/method: ${section.headerRaw.trim()}`, {
        header: section.headerRaw, signal: signal ?? null, from: source ?? null, to: target ?? null, method: method ?? null,
      });
    }
    return { source, signal, target, method, flags: parseConnectFlags(attrValue(section, "flags"), section) };
  });
}

/** 解析一条连接的 `flags=`:raw 为文件原文数值(没写该字段时为 null),semantic/otherBits 由 raw 拆位。 */
function parseConnectFlags(raw: string | undefined, section: GodotResourceSection): SceneConnectionFlags {
  if (raw === undefined) return { raw: null, semantic: [], otherBits: [] }; // 文件没写 flags= 就不伪造 0
  const t = raw.trim();
  if (!/^\d+$/.test(t) || Number(t) > 0x7fffffff) {
    throw new GodotMcpError("PARSE_ERROR", `[connection] 的 flags 不是 32 位非负整数: ${JSON.stringify(raw)}`, {
      header: section.headerRaw, flags: raw,
    });
  }
  const value = Number(t);
  const semantic = CONNECT_FLAG_NAMES.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);
  const named = CONNECT_FLAG_NAMES.reduce((mask, [bit]) => mask | bit, 0);
  const otherBits: number[] = [];
  for (let i = 0; i < 31; i++) {
    const bit = 1 << i;
    if ((value & bit) !== 0 && (named & bit) === 0) otherBits.push(bit);
  }
  return { raw: value, semantic, otherBits };
}

/** 该 `[node]` 段是否是子场景实例(`instance=` / `instance_placeholder=`)。 */
function isInstanceSection(section: GodotResourceSection): boolean {
  return section.attributes.some((a) => a.name === "instance" || a.name === "instance_placeholder");
}

/**
 * 实例的来源场景路径(解析不到就 undefined,**不猜**)。
 *   - `instance=ExtResource("id")` → 按本文件的 `[ext_resource path=…]` 解析;
 *   - `instance_placeholder="res://…"` 这类直接写路径原文的写法 → 采用原文(仅当它确实以 `res://` 开头)。
 * 注:占位实例的具体写法本仓样例未覆盖(未经 4.6.3 实测),所以这里只认"文本里明写着 res://"的情形。
 */
function instanceSceneOf(n: GodotNodeAST, ext: Map<string, string>): string | undefined {
  const raw = n.instance ?? n.instancePlaceholder;
  if (raw === undefined) return undefined;
  const resolved = resolveExtRef(raw, ext);
  if (resolved !== undefined) return resolved;
  const literal = decodeQuoted(raw);
  return literal.startsWith("res://") ? literal : undefined;
}

/**
 * 请求路径是否落在"本文件里某个实例节点的子树"内:返回最长的那个实例祖先路径与其来源场景。
 * 只认严格内部(`A/B` 对实例节点 `A`),实例节点自身不算 —— 那正是允许写覆盖的位置。
 */
function instantiatedAncestorOf(
  ast: GodotResourceAST, path: string,
): { nodePath: string; instanceScene?: string } | undefined {
  const ext = extResourcePaths(ast);
  let best: { nodePath: string; instanceScene?: string } | undefined;
  for (const section of findGodotResourceSections(ast, "node")) {
    if (!isInstanceSection(section)) continue;
    const owner = nodeSectionPath(section);
    if (owner === undefined || !path.startsWith(`${owner}/`)) continue;
    if (best === undefined || owner.length > best.nodePath.length) {
      const scene = resolveExtRef(attrValue(section, "instance") ?? attrValue(section, "instance_placeholder"), ext);
      best = scene === undefined ? { nodePath: owner } : { nodePath: owner, instanceScene: scene };
    }
  }
  return best;
}

/** "节点来自子场景内部"的明确错误(比裸的"节点不存在"更能说明为什么不能写)。 */
function insideInstanceError(
  nodePath: string, target: string, owner: { nodePath: string; instanceScene?: string },
): GodotMcpError {
  const scene = owner.instanceScene ?? "(来源场景路径未能从 instance= 解析出)";
  return new GodotMcpError(
    "INVALID_ARGUMENT",
    `nodePath 指向的节点在被实例化的子场景内部,不在当前场景文件的覆盖范围: ${nodePath}`
      + `(实例节点 ${owner.nodePath} ← ${scene})。本服务只改当前 .tscn 的覆盖属性,不会修改原子场景文件;`
      + `要改子场景自身的默认值,请把 path 指向那个场景文件。`,
    { param: "nodePath", nodePath, normalized: target, instantiatedAncestor: owner.nodePath, instanceScene: owner.instanceScene ?? null },
  );
}

/**
 * 实例节点覆盖写入的类型校验(**判据仅限能静态确定的字面量**)。
 * 只在"该属性在本节点已有覆盖值"且新旧字面量类型都能判定、又明显不符时报错;新增覆盖不猜。
 * 刻意不查 ClassDB、不解析 .gd 的 `@export` 注解 —— 写侧保持不依赖引擎(T6 起的约定)。
 */
function assertOverrideValueType(ast: GodotResourceAST, section: GodotResourceSection, key: string, value: string): void {
  const entry = section.body.find((e): e is GodotResourceProperty => e.kind === "property" && e.name === key);
  if (!entry) return;
  const types = declaredResourceTypes(ast);
  const existing = bodyValue(entry);
  const before = inferLiteralType(existing, types);
  const after = inferLiteralType(value, types);
  if (before === undefined || after === undefined || literalTypesCompatible(before, after)) return;
  const nodePath = nodeSectionPath(section) ?? "(未知节点)";
  throw new GodotMcpError(
    "INVALID_ARGUMENT",
    `写入值的类型与该实例节点的现有覆盖不符: ${nodePath}.${key} 现为 ${existing}(类型 ${before}),`
      + `新值 ${value} 是 ${after}。拒绝静默写入类型明显不符的值(判据只用字面量,未查 ClassDB)。`,
    { param: "value", key, nodePath, existingValue: existing, existingType: before, newType: after, value },
  );
}

/** 本文件的 `ExtResource("id")` / `SubResource("id")` → 类型名(取各自段头的 `type=`;两个命名空间分开)。 */
interface DeclaredResourceTypes { ext: Map<string, string>; sub: Map<string, string> }

function declaredResourceTypes(ast: GodotResourceAST): DeclaredResourceTypes {
  const collect = (tag: "ext_resource" | "sub_resource"): Map<string, string> => {
    const map = new Map<string, string>();
    for (const section of findGodotResourceSections(ast, tag)) {
      const id = attrValue(section, "id");
      const type = attrValue(section, "type");
      if (id !== undefined && type !== undefined) map.set(id, type);
    }
    return map;
  };
  return { ext: collect("ext_resource"), sub: collect("sub_resource") };
}

/**
 * 静态判定一个 .tscn 属性值的类型名;**判不出返回 undefined(不猜)**。
 * `ExtResource("id")`/`SubResource("id")` 的类型取自本文件的段头声明,解析不到 id 时同样不猜。
 */
function inferLiteralType(value: string, types: DeclaredResourceTypes): string | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  if (t === "true" || t === "false") return "bool";
  if (t === "null") return "null";
  if (t === "inf" || t === "-inf" || t === "nan") return "float";
  if (/^-?\d+$/.test(t)) return "int";
  if (/^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(t)) return "float";
  const ext = /^ExtResource\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(t);
  if (ext) return types.ext.get(decodeQuoted(ext[1]!));
  const sub = /^SubResource\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(t);
  if (sub) return types.sub.get(decodeQuoted(sub[1]!));
  if (t.startsWith("&")) return /^&"(?:[^"\\]|\\.)*"$/.test(t) ? "StringName" : undefined;
  if (t.startsWith("^")) return /^\^"(?:[^"\\]|\\.)*"$/.test(t) ? "NodePath" : undefined;
  if (t.startsWith('"')) return /^"(?:[^"\\]|\\.)*"$/.test(t) ? "String" : undefined;
  if (t.startsWith("{")) return "Dictionary";
  if (t.startsWith("[")) return "Array";
  const typed = /^(Array|Dictionary)\s*\[/.exec(t); // `Array[NodePath]([...])` 这类带泛型的写法
  if (typed) return typed[1];
  const ctor = /^([A-Za-z_]\w*)\s*\(/.exec(t);     // `Vector2(…)` / `Color(…)` / `NodePath(…)` 等构造字面量
  if (ctor) return ctor[1];
  return undefined;
}

/** Godot 会隐式互转的类型族;`null` 视为通配(给"原本为 null"的属性补值是合法修改)。 */
const LITERAL_TYPE_FAMILIES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["int", "float"]),
  new Set(["String", "StringName", "NodePath"]),
];

function literalTypesCompatible(a: string, b: string): boolean {
  if (a === b || a === "null" || b === "null") return true;
  return LITERAL_TYPE_FAMILIES.some((family) => family.has(a) && family.has(b));
}

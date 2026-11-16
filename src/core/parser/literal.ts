// Godot 文本字面量的"JSON 友好"解析:把 `name = value` 里的 value 原文解析成可直接消费的值。
//
// 用途:写侧工具在改完文件后回报结构化的 before/after,agent 不必再自己 parse diff 文本。
// 语义边界(重要):这里的值是**文件里写的静态值**,不是运行中的引擎值 ——
//   - 不查 ClassDB、不做隐式类型转换、不套用引擎默认值;
//   - Control 布局后的真实位置/尺寸由 runtime_inspect_ui(runtime preset)提供,与这里无关。
//
// 无法识别的写法(Transform2D / ExtResource / SubResource / 数组 / Dictionary / StringName …)
// 一律**只保留 raw**,不猜结构(见 parseGodotLiteral)。
// 格式依据:core/variant/variant_parser.cpp(4.7.2)的 token 写法;本模块纯字符串处理,零依赖。

/** 一个属性值的原文与(可解析时的)解析结果。 */
export type Literal = { raw: string; value?: unknown };

/**
 * 一次写入的静态前后值(写入侧工具统一用它回报)。
 * `property` 是属性名 / uniform 名 / @export 变量名 / project.godot 配置键名。
 */
export type LiteralChange = {
  property: string;
  /** 写入前文件里的值;该属性原本不在文件中时为 null(不伪造引擎默认值)。 */
  before: Literal | null;
  /** 写入后写进文件的值。 */
  after: Literal;
  /** 写入前该属性是否已存在于文件中(false = 本次新增)。 */
  inFile: boolean;
};

/**
 * 把 .tscn / .tres / project.godot 的属性字面量解析为 JSON 友好值;无法识别返回 undefined,调用方只保留 raw。
 *
 * 认得的写法:布尔 / null / 整数 / 浮点(含科学计数) / 字符串(JSON 转义) /
 * `Vector2[2i,3,4,4i]()` / `Color()` / `Rect2[2i]()` 这类**全数字**构造调用。
 * 不认得的:参数非数字、空参数(`Vector2()`)、以及其它任何构造调用(Transform2D / ExtResource / …)、数组、Dictionary。
 */
export function parseGodotLiteral(raw: string): unknown | undefined {
  const s = raw.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) { try { return JSON.parse(s); } catch { return undefined; } }
  const m = s.match(/^(Vector2i?|Vector3i?|Vector4i?|Color|Rect2i?)\(([^()]*)\)$/);
  if (m) {
    const parts = (m[2] ?? "").split(",").map((t) => t.trim());
    const nums = parts.map(Number);
    if (parts.every((t) => t !== "") && nums.every(Number.isFinite)) return { type: m[1], v: nums };
  }
  return undefined; // Transform2D / ExtResource / SubResource / 数组等保持 raw
}

/** 把原文包成 Literal;`raw` 为 null(属性不在文件中)时返回 null。 */
export function toLiteral(raw: string | null): Literal | null {
  if (raw === null) return null;
  const value = parseGodotLiteral(raw);
  return value === undefined ? { raw } : { raw, value };
}

/**
 * 组装一次写入的 change:调用方只给 before 的原文(null = 原本不在文件中)与 after 的原文,
 * 由本函数统一推导 Literal 与 inFile(避免各服务各写一遍判断而口径不一致)。
 */
export function literalChange(property: string, beforeRaw: string | null, afterRaw: string): LiteralChange {
  const before = toLiteral(beforeRaw);
  return { property, before, after: toLiteral(afterRaw) ?? { raw: afterRaw }, inFile: before !== null };
}

// ClassDB 元数据的来源:Godot 自己导出的扩展 API dump(`godot --headless --dump-extension-api`)。
//
// 为什么选它:它是**唯一**由引擎提供、无需 Godot 工程、可离线缓存的全量 ClassDB 快照
// (4.6.3 实测:6 768 977 B、1023 个类、退出码 0、stdout 只有横幅)。
//
// 已核实(2026-10-12,真实 4.6.3 产物;详见本仓 .vino-godot-mcp 缓存与 tests/sceneReadTools.real.test.ts):
//   - 顶层键 header / builtin_class_sizes / builtin_class_member_offsets / global_constants / global_enums /
//     utility_functions / builtin_classes / classes / singletons / native_structures。
//   - 每个类:name、is_refcounted、is_instantiable、inherits、api_type("core"|"editor")、methods、properties。
//     `enums` / `signals` / `constants` 是**可选键** —— 类没有该成员时整个键缺失(不是空数组)。
//   - properties 元素:{type, name, setter, getter[, index]};signals 元素:{name[, arguments:[{name,type}]]}
//     (无参信号没有 arguments 键);enums 元素:{name, is_bitfield, values:[{name,value}]}。
//   - **属性级 hint_string / hint / usage 不存在**(`--dump-extension-api-with-docs` 也没有,只多 description)。
//     属性与枚举的关联只体现在 setter 方法的参数类型上:`enum::<Class>.<Enum>`(位域为 `bitfield::…`)。
//
// 纯函数模块:只做参数构建与 JSON → 索引的转换,不碰文件系统(读/写缓存由 services/godotApiService 负责)。
import { GodotMcpError } from "../../core/errors.js";

/** 让引擎把 extension_api.json 写到**进程当前工作目录**的标志(4.6.3 `--help`:«in the current folder»)。 */
export const DUMP_EXTENSION_API_FLAG = "--dump-extension-api";

/** 引擎写出的固定文件名。 */
export const EXTENSION_API_FILE = "extension_api.json";

/** dump 的完整参数。`--headless` 避免弹窗;两个标志都在 tests/fixtures/godot-help.txt 里有据。 */
export function buildDumpExtensionApiArgs(): string[] {
  return ["--headless", DUMP_EXTENSION_API_FLAG];
}

export interface ApiEnumValue {
  name: string;
  value: number;
}

export interface ApiEnum {
  name: string;
  isBitfield: boolean;
  values: ApiEnumValue[];
}

export interface ApiSignalArgument {
  name: string;
  type: string;
}

export interface ApiSignal {
  name: string;
  /** 信号参数签名;无参信号为空数组(dump 里没有 arguments 键)。 */
  arguments: ApiSignalArgument[];
}

export interface ApiProperty {
  name: string;
  /** 属性类型名(dump 原样,如 "int" / "Vector2" / "Texture2D");枚举型属性这里是 "int"。 */
  type: string;
  /** 由 setter 参数类型 `enum::<Class>.<Enum>` / `bitfield::…` 推出的枚举名;推不出时缺省(不猜)。 */
  enumName?: string;
  getter?: string;
  setter?: string;
}

export interface ApiMethodArgument { name: string; type?: string; defaultValue?: string }
export interface ApiMethod { name: string; returnType?: string; arguments: ApiMethodArgument[]; isStatic: boolean; isVararg: boolean }

export interface ApiClass {
  name: string;
  /** 父类名;`Object` 没有 inherits 键。 */
  inherits?: string;
  /** dump 原文:`core` | `editor`。 */
  apiType: string;
  isInstantiable: boolean;
  /** 该类**自身声明**的属性(不合并继承来的;继承链由调用方按 inherits 走)。 */
  properties: ApiProperty[];
  signals: ApiSignal[];
  enums: ApiEnum[];
  methods: ApiMethod[];
  constants: Array<{ name: string; value: number }>;
}

export interface ExtensionApi {
  /** header.version_full_name,如 "Godot Engine v4.6.3.stable.official"(不含 build hash)。 */
  versionFullName?: string;
  /** 类名 → 类信息。 */
  classes: Map<string, ApiClass>;
  /** 全局枚举(properties/signals 里 `enum::<Name>` 无类名前缀时到这里找)。 */
  globalEnums: Map<string, ApiEnum>;
}

/**
 * 把 dump 文本转成精简索引。**只保留本工具需要的字段**(方法体全部丢弃 —— 它占了文件的大部分体积),
 * 因此进程内缓存的内存占用远小于原始 6.5MB JSON。
 * 结构不合法时抛 PARSE_ERROR(调用方据此判定缓存损坏并重 dump)。
 */
export function parseExtensionApi(raw: string): ExtensionApi {
  const root = asRecord(parseJson(raw, raw.length));
  const rawClasses = root ? asArray(root["classes"]) : [];
  if (!root || rawClasses.length === 0) {
    throw new GodotMcpError("PARSE_ERROR", "extension_api.json 里没有 classes 数组(不像是 --dump-extension-api 的产物)", {
      bytes: raw.length,
    });
  }

  const globalEnums = new Map<string, ApiEnum>();
  for (const e of asArray(root["global_enums"])) {
    const parsed = parseEnum(e);
    if (parsed) globalEnums.set(parsed.name, parsed);
  }

  const classes = new Map<string, ApiClass>();
  for (const rawClass of rawClasses) {
    const c = asRecord(rawClass);
    const name = c ? str(c["name"]) : undefined;
    if (!c || name === undefined) continue;
    const inherits = str(c["inherits"]);
    const info: ApiClass = {
      name,
      apiType: str(c["api_type"]) ?? "unknown",
      isInstantiable: c["is_instantiable"] === true,
      properties: parseProperties(c),
      signals: parseSignals(c),
      methods: parseMethods(c),
      constants: parseConstants(c),
      enums: asArray(c["enums"]).flatMap((e) => {
        const parsed = parseEnum(e);
        return parsed ? [parsed] : [];
      }),
    };
    if (inherits !== undefined) info.inherits = inherits;
    classes.set(name, info);
  }

  const header = asRecord(root["header"]);
  const versionFullName = header ? str(header["version_full_name"]) : undefined;
  return versionFullName === undefined ? { classes, globalEnums } : { versionFullName, classes, globalEnums };
}

/** 解析缓存文件名用的版本键:`--version` 的原文清洗成安全文件名;清洗后为空时退化为 "unknown"。 */
export function cacheKeyOf(version: string): string {
  const safe = version.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (safe === "" ? "unknown" : safe).slice(0, 120);
}

// ────────────────────────────── 内部 ──────────────────────────────

function parseJson(raw: string, bytes: number): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    throw new GodotMcpError("PARSE_ERROR", `extension_api.json 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`, { bytes });
  }
}

/**
 * 属性列表:枚举关联从 `set_<property>` 的参数类型里取 —— 这是 dump 里唯一的权威关联。
 *
 * 只用**单参数 int setter** 这一种形状,否则会造出假关联。反例(4.6.3 实测踩到):
 * `Control.offset_left`(float)的 setter 是 `set_offset(side: enum::Side, offset: float)` ——
 * 第一个参数是为了定位边而传的枚举,不是属性类型。所以要求:
 *   1. 属性类型必须是 `int`(枚举型属性在 dump 里都是 int);
 *   2. setter 必须恰好一个参数(多参数说明有额外的定位/索引参数);
 *   3. 该参数类型必须是 `enum::…` / `bitfield::…`。
 */
function parseProperties(c: Record<string, unknown>): ApiProperty[] {
  const setters = new Map<string, Array<string | undefined>>();
  for (const rawMethod of asArray(c["methods"])) {
    const m = asRecord(rawMethod);
    const methodName = m ? str(m["name"]) : undefined;
    if (!m || methodName === undefined) continue;
    setters.set(methodName, asArray(m["arguments"]).map((a) => str(asRecord(a)?.["type"])));
  }

  return asArray(c["properties"]).flatMap((rawProperty) => {
    const p = asRecord(rawProperty);
    const name = p ? str(p["name"]) : undefined;
    const type = p ? str(p["type"]) : undefined;
    if (!p || name === undefined || type === undefined) return [];
    const setter = str(p["setter"]);
    const getter = str(p["getter"]);
    const args = setter === undefined ? undefined : setters.get(setter);
    const enumName = type !== "int" || args?.length !== 1 ? undefined : enumRefOf(args[0]);
    return [enumName === undefined ? { name, type, ...(getter ? { getter } : {}), ...(setter ? { setter } : {}) } : { name, type, enumName, ...(getter ? { getter } : {}), ...(setter ? { setter } : {}) }];
  });
}

function parseMethods(c: Record<string, unknown>): ApiMethod[] {
  return asArray(c["methods"]).flatMap((raw) => {
    const m = asRecord(raw); const name = m ? str(m["name"]) : undefined;
    if (!m || !name) return [];
    const args = asArray(m["arguments"]).flatMap((rawArg) => { const a = asRecord(rawArg); const argName = a ? str(a["name"]) : undefined; if (!a || !argName) return []; const type = str(a["type"]); const def = str(a["default_value"]); return [{ name: argName, ...(type ? { type } : {}), ...(def ? { defaultValue: def } : {}) }]; });
    const ret = str(m["return_type"]); return [{ name, ...(ret ? { returnType: ret } : {}), arguments: args, isStatic: m["is_static"] === true, isVararg: m["is_vararg"] === true }];
  });
}

function parseConstants(c: Record<string, unknown>): Array<{ name: string; value: number }> {
  return asArray(c["constants"]).flatMap((raw) => { const x = asRecord(raw); const name = x ? str(x["name"]) : undefined; const value = x ? num(x["value"]) : undefined; return name === undefined || value === undefined ? [] : [{ name, value }]; });
}

/** `enum::Control.FocusMode` / `bitfield::Control.SizeFlags` → "Control.FocusMode";其它类型返回 undefined。 */
function enumRefOf(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  for (const prefix of ["enum::", "bitfield::"]) {
    if (type.startsWith(prefix) && type.length > prefix.length) return type.slice(prefix.length);
  }
  return undefined;
}

function parseSignals(c: Record<string, unknown>): ApiSignal[] {
  return asArray(c["signals"]).flatMap((rawSignal) => {
    const s = asRecord(rawSignal);
    const name = s ? str(s["name"]) : undefined;
    if (!s || name === undefined) return [];
    const args = asArray(s["arguments"]).flatMap((rawArg) => {
      const a = asRecord(rawArg);
      const argName = a ? str(a["name"]) : undefined;
      const argType = a ? str(a["type"]) : undefined;
      return argName === undefined || argType === undefined ? [] : [{ name: argName, type: argType }];
    });
    return [{ name, arguments: args }];
  });
}

function parseEnum(rawEnum: unknown): ApiEnum | undefined {
  const e = asRecord(rawEnum);
  const name = e ? str(e["name"]) : undefined;
  if (!e || name === undefined) return undefined;
  const values = asArray(e["values"]).flatMap((rawValue) => {
    const v = asRecord(rawValue);
    const valueName = v ? str(v["name"]) : undefined;
    const value = v ? num(v["value"]) : undefined;
    return valueName === undefined || value === undefined ? [] : [{ name: valueName, value }];
  });
  return { name, isBitfield: e["is_bitfield"] === true, values };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

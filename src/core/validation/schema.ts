import type { JsonSchema } from "../../types/index.js";

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: string[] };

/** 最小 JSON Schema 校验器:type/enum/required/properties/items/min/max/minLength/default。 */
export function validate(schema: JsonSchema, input: unknown): ValidationResult {
  const errors: string[] = [];
  const value = check(schema, input, "$", errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function check(s: JsonSchema, v: unknown, path: string, errors: string[]): unknown {
  if (v === undefined && s.default !== undefined) v = s.default;
  if (s.enum && !s.enum.includes(v as string | number)) {
    errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
    return v;
  }
  switch (s.type) {
    case undefined: return v;
    case "string":
      if (typeof v !== "string") { errors.push(`${path}: expected string, got ${typeOf(v)}`); return v; }
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
      return v;
    case "number": case "integer": {
      // Number.isFinite 同时挡住 NaN 与 Infinity:JSON 表达不了它们,但进程内调用仍可能传进来。
      if (typeof v !== "number" || !Number.isFinite(v)) { errors.push(`${path}: expected ${s.type}, got ${typeOf(v)}`); return v; }
      if (s.type === "integer" && !Number.isInteger(v)) errors.push(`${path}: expected integer`);
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: must be >= ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: must be <= ${s.maximum}`);
      return v;
    }
    case "boolean":
      if (typeof v !== "boolean") errors.push(`${path}: expected boolean, got ${typeOf(v)}`);
      return v;
    case "array": {
      if (!Array.isArray(v)) { errors.push(`${path}: expected array, got ${typeOf(v)}`); return v; }
      return s.items ? v.map((x, i) => check(s.items as JsonSchema, x, `${path}[${i}]`, errors)) : v;
    }
    case "object": {
      if (typeOf(v) !== "object") { errors.push(`${path}: expected object, got ${typeOf(v)}`); return v; }
      const obj = v as Record<string, unknown>;
      const props = s.properties ?? {};
      const out: Record<string, unknown> = {};
      for (const key of s.required ?? []) {
        if (obj[key] === undefined && props[key]?.default === undefined) errors.push(`${path}.${key}: required`);
      }
      for (const [key, val] of Object.entries(obj)) {
        const sub = props[key];
        if (!sub) {
          if (s.additionalProperties === true) out[key] = val;
          else errors.push(`${path}.${key}: unknown parameter`);
          continue;
        }
        out[key] = check(sub, val, `${path}.${key}`, errors);
      }
      for (const [key, sub] of Object.entries(props)) {
        if (!(key in out) && sub.default !== undefined) out[key] = sub.default;
      }
      return out;
    }
  }
}

// 分层依赖检查:防止后续(尤其是接力的模型)把架构写坏。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

// 每个层允许 import 的层。src/index.ts、src/dev-cli.ts 是组合根,不受限。
const ALLOWED: Record<string, string[]> = {
  types: [],
  core: ["types"],
  godot: ["types", "core"],
  services: ["types", "core", "godot"],
  tools: ["types", "services"],          // Tool 只经 Service 访问底层;Tool 之间禁止互相 import
  mcp: ["types", "core"],                // MCP 层不认识具体工具/服务
};
// 例外:Tool 允许直接使用 core/errors(抛错误码)
const TOOL_CORE_ALLOWED = new Set(["core/errors"]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
}
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) out.push((m[1] ?? m[2]) as string);
  return out.filter((s) => s.startsWith("."));
}

test("layer dependency rules", () => {
  const violations: string[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, "/");
    const layer = rel.split("/")[0] as string;
    if (!(layer in ALLOWED)) continue; // index.ts / dev-cli.ts
    for (const spec of importsOf(file)) {
      const target = path.relative(SRC, path.resolve(path.dirname(file), spec)).replace(/\\/g, "/").replace(/\.js$/, "");
      const tLayer = target.split("/")[0] as string;
      if (tLayer === layer) {
        if (layer === "tools" && target.split("/")[1] !== rel.split("/")[1] && rel !== "tools/index.ts") violations.push(`${rel} -> ${target} (Tool -> Tool across domains)`);
        if (layer === "tools" && target.split("/")[1] === rel.split("/")[1] && rel !== "tools/index.ts" && target !== rel.replace(/\.ts$/, "")) violations.push(`${rel} -> ${target} (Tool -> Tool)`);
        continue;
      }
      const ok = ALLOWED[layer]!.includes(tLayer) || (layer === "tools" && TOOL_CORE_ALLOWED.has(target));
      if (!ok) violations.push(`${rel} -> ${target} (${layer} must not import ${tLayer})`);
    }
  }
  assert.deepEqual(violations, []);
});

test("only sdkServer.ts touches the MCP SDK", () => {
  const offenders = walk(SRC).filter((f) => !f.endsWith("sdkServer.ts") && /@modelcontextprotocol/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

// 例外只有两个入口:dev-cli.ts(调试 CLI)与 index.ts(--version/--help 等 CLI 自检输出)。
// 服务体内部的任何文件都不允许碰 stdout;stdio 期间 stdout 必须干净(mcpServer.test.ts 覆盖)。
const STDOUT_ALLOWED = new Set(["dev-cli.ts", "index.ts"]);

test("stdout is reserved for MCP: no console.log in src (except CLI entries)", () => {
  const offenders = walk(SRC).filter((f) => !STDOUT_ALLOWED.has(path.basename(f)) && /console\.log|process\.stdout/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

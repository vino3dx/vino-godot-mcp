// P0 文档一致性回归:README / 桥文档里硬编码的工具数量与能力描述必须和源码一致。
// README 中英文两版各自有一份 Tool Matrix,两版都要求覆盖 allTools 的全部工具。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allTools } from "../src/tools/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(): string {
  const starts = [process.cwd(), HERE, path.resolve(HERE, ".."), path.resolve(HERE, "../..")];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "README.md"))) return dir;
      dir = path.dirname(dir);
    }
  }
  throw new Error(`cannot locate repository root (cwd=${process.cwd()}, module=${HERE})`);
}

const ROOT = findRepoRoot();
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const bridgeDoc = fs.readFileSync(path.join(ROOT, "docs", "GODOT_NATIVE_BRIDGE.md"), "utf8");

/** Tool Matrix 的领域行(中英文都复用同一个表格骨架,整行匹配才能拿到工具名)。 */
const MATRIX_ROW = /^\|\s*(Utility|Runtime|Project|Scene|Resource|Shader|Script|Class|Asset|Editor)[^\n]*$/gm;

function matrixTools(text: string): string[] {
  const names: string[] = [];
  for (const row of text.match(MATRIX_ROW) ?? []) {
    for (const match of row.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) names.push(match[1]!);
  }
  return names;
}

const ZH_ANCHOR = readme.indexOf('<a id="中文">');
const englishSection = ZH_ANCHOR === -1 ? readme : readme.slice(0, ZH_ANCHOR);
const chineseSection = ZH_ANCHOR === -1 ? "" : readme.slice(ZH_ANCHOR);

test("README startup-log sample matches the real tool count", () => {
  const count = allTools.length;
  const matches = readme.match(new RegExp(`${count} tools exposed`, "g")) ?? [];
  // 英文段 + 中文段各一处示例
  assert.equal(matches.length, 2, `README must show "${count} tools exposed" in both language sections`);
  assert.equal(/55 tools exposed/.test(readme), false, "stale tool count '55' must be gone");
});

test("every registered tool appears in the README Tool Matrix", () => {
  const listed = new Set(matrixTools(readme));
  const missing = allTools.map((t) => t.name).filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], `tools missing from README Tool Matrix: ${missing.join(", ")}`);
});

test("English and Chinese Tool Matrix rows describe the same domains", () => {
  assert.ok(ZH_ANCHOR > 0, "README must keep the <a id=\"中文\"> anchor");
  const englishRows = englishSection.match(MATRIX_ROW) ?? [];
  const chineseRows = chineseSection.match(MATRIX_ROW) ?? [];
  assert.ok(englishRows.length >= 10, `expected >=10 English matrix rows, got ${englishRows.length}`);
  assert.ok(chineseRows.length >= 10, `expected >=10 Chinese matrix rows, got ${chineseRows.length}`);
  assert.deepEqual([...new Set(matrixTools(englishSection))].sort(), [...new Set(matrixTools(chineseSection))].sort());
});

test("README documents the read-only Editor Bridge and its dependency", () => {
  assert.match(readme, /Editor Bridge \(read-only\)/);
  assert.match(readme, /编辑器桥（只读）/);
  assert.match(readme, /BRIDGE_UNAVAILABLE/);
  // 不能暗示桥可以做原生写
  assert.match(readme, /engine-native write channel is \*\*not implemented\*\*/i);
});

test("bridge doc reflects the implemented read-only channel and the missing write channel", () => {
  assert.equal(
    /No EditorPlugin or native object RPC endpoint is currently part of the repository/.test(bridgeDoc),
    false,
    "bridge doc still claims no EditorPlugin exists",
  );
  assert.match(bridgeDoc, /read-only/i);
  assert.match(bridgeDoc, /write channel uses the same framing but is not implemented/i);
  assert.match(bridgeDoc, /engine-native \*\*write\*\* channel .* is NOT implemented/is);
});

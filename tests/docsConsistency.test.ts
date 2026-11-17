// P0 文档一致性回归:README / 桥文档里硬编码的工具数量与能力描述必须和源码一致。
// README 中英文两版各自有一份 Tool Matrix,两版都要求覆盖 allTools 的全部工具。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allTools } from "../src/tools/index.js";
import { SCENE_FIRST_POLICY } from "../src/services/developmentGuidelines.js";

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

test("README documents the two-way Editor Bridge and its dependency", () => {
  assert.match(readme, /Editor Bridge \(read \+ write\)/);
  assert.match(readme, /编辑器桥（读写）/);
  assert.match(readme, /BRIDGE_UNAVAILABLE/);
  // 写通道的两条硬事实:走 UndoRedo(可 Ctrl+Z 撤销)且不落盘。
  assert.match(readme, /EditorUndoRedoManager/);
  assert.match(readme, /Ctrl\+Z/);
});

test("bridge doc reflects the implemented event push and UndoRedo write channel", () => {
  assert.equal(
    /No EditorPlugin or native object RPC endpoint is currently part of the repository/.test(bridgeDoc),
    false,
    "bridge doc still claims no EditorPlugin exists",
  );
  assert.match(bridgeDoc, /EditorUndoRedoManager/);
  assert.match(bridgeDoc, /editor_get_events/);
  assert.equal(/NOT implemented/.test(bridgeDoc), false, "the write channel is implemented; the doc must not claim otherwise");
});

// P1-D: Scene-First 是共享策略,不是各写一份的文案。
const SCENE_FIRST_TOOLS = [
  "scene_add_node",
  "scene_add_visual_node",
  "scene_update_node_property",
  "scene_set_ui_layout",
  "scene_connect_signal",
  "script_create",
] as const;

test("every scene-writing tool embeds the shared Scene-First policy text", () => {
  for (const name of SCENE_FIRST_TOOLS) {
    const tool = allTools.find((t) => t.name === name);
    assert.ok(tool, `missing tool ${name}`);
    assert.ok(
      tool.description.includes(SCENE_FIRST_POLICY),
      `${name} description must embed SCENE_FIRST_POLICY (single source: src/services/developmentGuidelines.ts)`,
    );
  }
});

test("runtime_inspect_ui is a real tool and every reference is preset-qualified", () => {
  assert.ok(allTools.some((t) => t.name === "runtime_inspect_ui"), "runtime_inspect_ui must be registered");
  for (const tool of allTools) {
    if (tool.name === "runtime_inspect_ui" || !tool.description.includes("runtime_inspect_ui")) continue;
    assert.match(
      tool.description,
      /runtime_inspect_ui[^.]*runtime preset/,
      `${tool.name} must state that runtime_inspect_ui needs the runtime preset`,
    );
  }
  assert.match(readme, /Runtime and editor tools are \*\*not exposed by the default preset\*\*/);
  assert.match(readme, /Runtime 与 editor 工具\*\*不在默认预设中\*\*/);
});

test("README documents Scene-First Development in both languages", () => {
  assert.match(readme, /### Scene-First Development/);
  assert.match(readme, /### 场景优先开发（Scene-First Development）/);
  assert.match(readme, /Create nodes at runtime only for content that is genuinely dynamic\./);
  assert.match(readme, /只有内容确实需要动态生成时，才在运行时创建节点。/);
  assert.match(readme, /`scene_create` is not part of this version/);
  assert.match(readme, /`scene_create` 不属于本版本/);
});

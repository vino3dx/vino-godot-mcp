// T2 真实引擎验收:value_codec.gd 的 Variant 解析必须与 Godot 4.6 实际行为一致。
// 流程:临时工程 ← 拷贝仓库 addon → 写入探针(tests/fixtures/t2_value_codec.gd)
//      → godot --headless --script res://probe.gd → 逐条核对 T2PASS/T2FAIL。
// 约定:GODOT_BIN 未设置则整组 skip(SKIP 不等于 PASS)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunRunner } from "../src/godot/runtime/run.js";

const GODOT_BIN = process.env["GODOT_BIN"];
const ADDON = path.join(import.meta.dirname!, "..", "..", "godot_test", "addons", "vino-godot-mcp");
const PROBE = path.join(import.meta.dirname!, "..", "..", "tests", "fixtures", "t2_value_codec.gd");
const skip = GODOT_BIN ? false : "GODOT_BIN 未设置";

test("T2: value_codec 的 Variant 解析与 Godot 4.6 一致", { skip, timeout: 180_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-t2-codec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="T2Codec"\n', "utf8");
  fs.cpSync(ADDON, path.join(dir, "addons", "vino-godot-mcp"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "probe.gd"));

  const result = await defaultRunRunner(
    GODOT_BIN as string,
    ["--headless", "--path", dir, "--script", "res://probe.gd"],
    { timeoutMs: 150_000 },
  );

  const out = `${result.stdout}\n${result.stderr}`;
  const failed = out.split("\n").filter((l) => l.startsWith("T2FAIL|")).map((l) => l.slice("T2FAIL|".length));
  const passed = out.split("\n").filter((l) => l.startsWith("T2PASS|")).map((l) => l.slice("T2PASS|".length));
  const summary = out.split("\n").find((l) => l.startsWith("T2SUMMARY|"));

  // 探针没跑起来(编译错误 / 引擎崩溃)时不能算通过。
  assert.ok(summary !== undefined, `probe did not run; exit=${result.exitCode}\n${out.slice(-4000)}`);
  assert.deepEqual(failed, [], `value_codec assertions failed: ${failed.join(", ")}\n${out.slice(-4000)}`);
  assert.ok(passed.length >= 20, `expected at least 20 assertions, got ${passed.length}`);
  assert.match(summary as string, /fails=0/);
});

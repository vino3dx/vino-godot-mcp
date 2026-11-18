// T5 补充真实引擎验收:log_capture.gd 的订阅、分级与自身过滤。
//
// 为什么不复用 T29:编辑器对脚本的解析是懒加载的,写坏一个孤立 .gd 不会触发 reparse
// (实测 headless 编辑器 stderr 零输出),所以"丢一个坏脚本等编辑器报错"在自动化环境里不成立。
// 这里改成确定性探针:直接驱动 Logger 回调,断言  error / warning 分流、自身前缀过滤、
// 以及 T3 依赖的 function/file/line 诊断字段。
//
// 约定:GODOT_BIN 未设置则整组 skip(SKIP 不等于 PASS)。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunRunner } from "../src/godot/runtime/run.js";

const GODOT_BIN = process.env["GODOT_BIN"];
const ROOT = path.join(import.meta.dirname!, "..", "..");
const ADDON = path.join(ROOT, "godot_test", "addons", "vino-godot-mcp");
const PROBE = path.join(ROOT, "tests", "fixtures", "log_capture_probe.gd");
const skip = GODOT_BIN ? false : "GODOT_BIN 未设置";

test("T5: log_capture 的订阅/分级/过滤与真实引擎一致", { skip, timeout: 120_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-logcap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="LogCap"\n', "utf8");
  fs.cpSync(ADDON, path.join(dir, "addons", "vino-godot-mcp"), { recursive: true });
  fs.copyFileSync(PROBE, path.join(dir, "probe.gd"));

  const result = await defaultRunRunner(GODOT_BIN as string, ["--headless", "--path", dir, "--script", "res://probe.gd"], {
    timeoutMs: 90_000,
  });

  const out = `${result.stdout}\n${result.stderr}`;
  const lines = out.split("\n");
  const failed = lines.filter((l) => l.startsWith("LOGFAIL|")).map((l) => l.slice("LOGFAIL|".length));
  const passed = lines.filter((l) => l.startsWith("LOGPASS|")).map((l) => l.slice("LOGPASS|".length));
  const summary = lines.find((l) => l.startsWith("LOGSUMMARY|"));

  // 探针没跑起来(编译错误 / 引擎崩溃)时不能算通过。
  assert.ok(summary !== undefined, `probe did not run; exit=${result.exitCode}\n${out.slice(-4000)}`);
  assert.deepEqual(failed, [], `log_capture assertions failed: ${failed.join(", ")}\n${out.slice(-4000)}`);
  assert.ok(passed.length >= 14, `expected at least 14 assertions, got ${passed.length}`);
  assert.match(summary as string, /fails=0/);
});

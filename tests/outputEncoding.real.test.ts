// P2-B 真实引擎验收:中文目录/文件名、长中文输出、真实 Godot 子进程。
// 输出必须为合法 UTF-8、无 U+FFFD,且 stdoutEncoding 如实报告。
// 约定:GODOT_BIN 未设置则整组 skip。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunRunner } from "../src/godot/runtime/run.js";
import { getGodotVersion } from "../src/godot/cli.js";

const GODOT_BIN = process.env["GODOT_BIN"];
const TIMEOUT_MS = 120_000;

const SCRIPT = `extends SceneTree

func _init() -> void:
\tfor i in range(5000):
\t\tprint("中文输出校验-", i)
\tquit()
`;

function makeProject(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-encoding-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "project.godot"), 'config_version=5\n\n[application]\n\nconfig/name="编码测试"\n', "utf8");
  fs.mkdirSync(path.join(dir, "脚本"), { recursive: true });
  fs.writeFileSync(path.join(dir, "脚本", "打印中文.gd"), SCRIPT, "utf8");
  fs.mkdirSync(path.join(dir, "场景"), { recursive: true });
  fs.writeFileSync(path.join(dir, "场景", "主场景.tscn"), '[gd_scene format=3]\n\n[node name="根节点" type="Node"]\n', "utf8");
  return dir;
}

test("a real Godot process keeps Chinese output intact across chunks", { skip: GODOT_BIN === undefined ? "GODOT_BIN is not set" : false }, async (t) => {
  const dir = makeProject(t);
  const res = await defaultRunRunner(GODOT_BIN!, [
    "--headless", "--path", dir, "--script", "res://脚本/打印中文.gd",
  ], { timeoutMs: TIMEOUT_MS });

  assert.equal(res.exitCode, 0, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.equal(res.stdoutEncoding, "utf-8");
  assert.equal(res.stdout.includes("\uFFFD"), false, "no replacement characters");
  assert.ok(res.stdout.includes("中文输出校验-0"), "first line missing");
  assert.ok(res.stdout.includes("中文输出校验-4999"), "last line missing (output was truncated or corrupted)");
});

test("godot --version goes through the same decoder", { skip: GODOT_BIN === undefined ? "GODOT_BIN is not set" : false }, async () => {
  const info = await getGodotVersion({ env: { ...process.env, GODOT_PATH: GODOT_BIN } });
  assert.match(info.version, /^\d+\.\d+/);
  assert.equal(info.raw.includes("\uFFFD"), false);
});

test("a missing Chinese script path fails with structured exit info", { skip: GODOT_BIN === undefined ? "GODOT_BIN is not set" : false }, async (t) => {
  const dir = makeProject(t);
  const res = await defaultRunRunner(GODOT_BIN!, [
    "--headless", "--path", dir, "--script", "res://脚本/不存在.gd",
  ], { timeoutMs: TIMEOUT_MS });
  assert.notEqual(res.exitCode, 0, "Godot must fail for a missing script");
  assert.equal(res.stderr.includes("\uFFFD"), false);
  assert.equal(typeof res.stderrEncoding, "string");
});

// P1-B 真实引擎验收:resource_check_uid 的解析结果必须与 Godot 的 ResourceUID 一致。
// 流程:临时工程 → godot --import 建立 uid_cache → 我们的检查 → `--script` 打印
// ResourceUID.has_id/get_id_path → 对比 ok / mismatch / unresolved 三种结论。
// 约定:GODOT_BIN 未设置则整组 skip。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UidCheckService } from "../src/services/uidService.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { defaultRunRunner } from "../src/godot/runtime/run.js";

const GODOT_BIN = process.env["GODOT_BIN"];
const TIMEOUT_MS = 120_000;

const PLAYER_UID = "uid://h01h8fbt8xem";   // 来自仓库内真实引擎生成的 .gd.uid
const OTHER_UID = "uid://rilh0sf184pg";    // 来自仓库内真实引擎生成的 .tscn 段头
const DANGLING_UID = "uid://v000000000000";

const PROBE = `extends SceneTree

func _init() -> void:
\tfor uid in ["${PLAYER_UID}", "${OTHER_UID}", "${DANGLING_UID}"]:
\t\tvar id: int = ResourceUID.text_to_id(uid)
\t\tprint("UIDRESULT|", uid, "|", str(ResourceUID.has_id(id)), "|", ResourceUID.get_id_path(id))
\tquit()
`;

const REFS = [
  '[gd_scene format=3 uid="uid://refsreal1"]',
  "",
  `[ext_resource type="Script" uid="${PLAYER_UID}" path="res://player.gd" id="ok"]`,
  `[ext_resource type="Script" uid="${OTHER_UID}" path="res://player.gd" id="mismatch"]`,
  `[ext_resource type="Script" uid="${DANGLING_UID}" path="res://player.gd" id="dangling"]`,
  '[ext_resource type="Script" path="res://player.gd" id="no_uid"]',
  `[ext_resource type="Script" uid="${PLAYER_UID}" path="res://missing.gd" id="missing_path"]`,
  "",
  '[node name="Root" type="Node"]',
  "",
].join("\n");

function makeProject(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-uid-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel: string, data: string): void => {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data, "utf8");
  };
  write("project.godot", 'config_version=5\n\n[application]\n\nconfig/name="UidReal"\n');
  write("player.gd", "extends Node\n");
  write("player.gd.uid", `${PLAYER_UID}\n`);
  write("other.gd", "extends Node\n");
  write("other.gd.uid", `${OTHER_UID}\n`);
  write("refs.tscn", REFS);
  write("probe.gd", PROBE);
  return dir;
}

test("our uid/path verdicts match the real engine", { skip: GODOT_BIN === undefined ? "GODOT_BIN is not set" : false }, async (t) => {
  const dir = makeProject(t);

  // 1) 引擎先建立 uid_cache(否则 ResourceUID 只知道空表)。
  const imported = await defaultRunRunner(GODOT_BIN!, ["--headless", "--path", dir, "--import"], { timeoutMs: TIMEOUT_MS });
  assert.equal(imported.exitCode, 0, `godot --import failed:\nstdout=${imported.stdout}\nstderr=${imported.stderr}`);

  // 2) 我们的检查。
  const report = new UidCheckService(new ProjectResolver({ cwd: dir })).check(dir, "res://refs.tscn");
  const get = (id: string) => report.issues.find((i) => i.resourceId === id);
  assert.equal(report.ok, 1, JSON.stringify(report));
  assert.equal(get("mismatch")?.status, "uid_mismatch");
  assert.equal(get("mismatch")?.resolvedPath, "res://other.gd");
  assert.equal(get("dangling")?.status, "uid_unresolved");
  assert.equal(get("no_uid")?.status, "uid_missing");
  assert.equal(get("missing_path")?.status, "path_missing");

  // 3) 引擎侧唯一的真相。
  const probe = await defaultRunRunner(GODOT_BIN!, ["--headless", "--path", dir, "--script", "res://probe.gd"], { timeoutMs: TIMEOUT_MS });
  assert.equal(probe.exitCode, 0, `godot script failed:\nstdout=${probe.stdout}\nstderr=${probe.stderr}`);
  const rows = probe.stdout.split(/\r?\n/).filter((l) => l.startsWith("UIDRESULT|")).map((line) => {
    const [, uid, has, resolved] = line.split("|");
    return { uid, has: has === "true", resolved };
  });
  const engine = new Map(rows.map((r) => [r.uid, r]));
  assert.equal(engine.get(PLAYER_UID)?.has, true, `engine does not know ${PLAYER_UID}: ${probe.stdout}`);
  assert.equal(engine.get(PLAYER_UID)?.resolved, "res://player.gd");
  assert.equal(engine.get(OTHER_UID)?.resolved, "res://other.gd");
  assert.equal(engine.get(DANGLING_UID)?.has, false, "dangling uid must not exist in the engine either");
  assert.equal(engine.get(DANGLING_UID)?.resolved, "");

  // 4) 结论一致:引擎也说 OTHER_UID 指向 other.gd,而 .tscn 里 path=player.gd。
  assert.equal(get("mismatch")?.resolvedPath, engine.get(OTHER_UID)?.resolved);
});

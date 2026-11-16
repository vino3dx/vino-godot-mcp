// P0-A 真实引擎验收:用真实 Godot 4.6.3 导入 PNG,再读回 asset_list 的 importStatus。
// 约定与其它 real 套件一致:只读 GODOT_BIN,未设置则整组 skip。
// 覆盖:未导入 → 引擎导入后 imported → 删除产物后 artifact_missing。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssetService } from "../src/services/assetService.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { defaultRunRunner } from "../src/godot/runtime/run.js";

const GODOT_BIN = process.env["GODOT_BIN"];
const TIMEOUT_MS = 120_000;
const HERE = import.meta.dirname!;
const SAMPLE_PNG = path.join(HERE, "..", "..", "tests", "fixtures", "sample_project", "icon_fixture.png");

function makeProject(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-p0a-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "project.godot"),
    'config_version=5\n\n[application]\n\nconfig/name="P0ARealImport"\n',
    "utf8",
  );
  fs.copyFileSync(SAMPLE_PNG, path.join(dir, "icon_fixture.png"));
  return dir;
}

test("real Godot import drives asset_list importStatus", { skip: GODOT_BIN === undefined ? "GODOT_BIN is not set" : false }, async (t) => {
  const dir = makeProject(t);
  const assets = new AssetService(new ProjectResolver({ cwd: dir }));

  // 1) 引擎尚未导入:没有 .import。
  assert.equal(assets.getInfo(dir, "res://icon_fixture.png").importStatus, "not_imported");

  // 2) 真实引擎导入。
  const run = await defaultRunRunner(GODOT_BIN!, ["--headless", "--path", dir, "--import"], { timeoutMs: TIMEOUT_MS });
  assert.equal(run.exitCode, 0, `godot --import failed:\nstdout=${run.stdout}\nstderr=${run.stderr}`);

  const importFile = path.join(dir, "icon_fixture.png.import");
  assert.ok(fs.existsSync(importFile), "Godot must write the .import record");

  const imported = assets.getInfo(dir, "res://icon_fixture.png");
  assert.equal(imported.importStatus, "imported", JSON.stringify(imported.importDetails));
  assert.equal(imported.imported, true);
  const artifact = imported.importDetails.artifacts?.[0];
  assert.ok(artifact?.startsWith("res://.godot/imported/"), `unexpected artifact: ${artifact}`);
  const artifactAbs = path.join(dir, ...artifact!.slice("res://".length).split("/"));
  assert.ok(fs.existsSync(artifactAbs), "reported artifact must exist on disk");

  // 3) 删除产物后必须降级,不能继续报 imported。
  fs.rmSync(artifactAbs);
  const degraded = assets.getInfo(dir, "res://icon_fixture.png");
  assert.equal(degraded.importStatus, "artifact_missing");
  assert.equal(degraded.imported, false);
});

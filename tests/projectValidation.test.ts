import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { ProjectValidationService } from "../src/services/projectValidationService.js";

test("project validation separates syntax, resources and runtime status", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vino-godot-mcp-validate-"));
  fs.writeFileSync(path.join(root, "project.godot"), "[application]\nconfig/name=\"Validate\"\n");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "main.gd"), "extends Node\n");
  fs.writeFileSync(path.join(root, "main.tscn"), `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Texture2D" path="res://missing.png" id="1_missing"]\n\n[node name="Main" type="Node"]\n`);
  const runner = async (_file: string, args: readonly string[]) => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 1, ...(args.includes("--check-only") ? {} : {}) });
  const fakeGodot = { locate: () => ({ path: "godot", source: "PATH" as const }) };
  const service = new ProjectValidationService({ godot: fakeGodot as never, project: new ProjectResolver({ cwd: root }), runQueue: new TaskQueue(new LockManager()), runner });
  const result = await service.validate({ tool: "project_validate" });
  assert.equal(result.syntaxValidated, true);
  assert.equal(result.resourceValidated, false);
  assert.equal(result.runtimeValidated, true);
  assert.equal(result.issues[0]?.type, "MISSING_RESOURCE");
});

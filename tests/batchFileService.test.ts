import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { FileService } from "../src/services/fileService.js";
import { BatchFileService } from "../src/services/batchFileService.js";
import { sha256Hex } from "../src/core/filesystem/safeWrite.js";
import { safeWriteFile } from "../src/core/filesystem/safeWrite.js";

function fixture(): { root: string; batch: BatchFileService } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vino-godot-mcp-batch-"));
  fs.writeFileSync(path.join(root, "project.godot"), "[application]\nconfig/name=\"Batch\"\n");
  fs.writeFileSync(path.join(root, "a.gd"), "extends Node\n");
  fs.writeFileSync(path.join(root, "b.gd"), "extends Node\n");
  const file = new FileService(new ProjectResolver({ cwd: root }));
  return { root, batch: new BatchFileService(file, new LockManager()) };
}

test("batch preview does not write and commit writes all files", async () => {
  const { root, batch } = fixture();
  const before = fs.readFileSync(path.join(root, "a.gd"), "utf8");
  const changes = [{ path: "res://a.gd", content: "extends Node\n# changed\n" }, { path: "res://b.gd", content: "extends Node\n# changed\n" }];
  const preview = await batch.apply(root, changes, "preview", "test");
  assert.equal(preview.mode, "preview"); assert.equal(preview.valid, true); assert.equal(fs.readFileSync(path.join(root, "a.gd"), "utf8"), before);
  const result = await batch.apply(root, changes, "commit", "test");
  assert.equal(result.committed, true); assert.equal(fs.readFileSync(path.join(root, "b.gd"), "utf8"), changes[1]!.content);
});

test("batch rejects hash conflict and duplicate targets before writing", async () => {
  const { root, batch } = fixture();
  await assert.rejects(() => batch.apply(root, [{ path: "res://a.gd", content: "x", expectedHash: sha256Hex("wrong") }, { path: "res://b.gd", content: "y" }], "commit", "test"), /File changed/);
  assert.equal(fs.readFileSync(path.join(root, "b.gd"), "utf8"), "extends Node\n");
  await assert.rejects(() => batch.apply(root, [{ path: "res://a.gd", content: "x" }, { path: "res://a.gd", content: "y" }], "preview", "test"), /重复/);
});

test("batch attempts recovery after a mid-commit failure and reports recovery failure", async () => {
  const { root } = fixture();
  let actualWrites = 0;
  let failRestore = false;
  const writer = async (file: string, content: string, opts: Parameters<typeof safeWriteFile>[2] = {}) => {
    if (!opts.dryRun) {
      actualWrites++;
      if (actualWrites === 2) throw new Error("simulated write failure");
      if (failRestore) throw new Error("simulated restore failure");
      failRestore = true;
    }
    return safeWriteFile(file, content, opts);
  };
  const file = new FileService(new ProjectResolver({ cwd: root }));
  const batch = new BatchFileService(file, new LockManager(), writer);
  const result = await batch.apply(root, [{ path: "res://a.gd", content: "a\n" }, { path: "res://b.gd", content: "b\n" }], "commit", "test");
  assert.equal(result.mode, "commit");
  assert.equal(result.committed, false);
  assert.equal(result.recovered, false);
  assert.equal(result.recoveryComplete, false);
  assert.ok(result.files.some((f) => f.status === "restore_failed"));
});

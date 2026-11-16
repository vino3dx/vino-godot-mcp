import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { normalizeEol, safeWriteFile, sha256Hex } from "../src/core/filesystem/safeWrite.js";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gaim-safewrite-"));

test("writes atomically, normalizes to LF, reports changed/newHash", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "old\r\nline\r\n");

  const out = await safeWriteFile(file, "new\r\nline\r\n");
  assert.equal(out.changed, true);
  assert.equal(fs.readFileSync(file, "utf8"), "new\nline\n");
  assert.equal(out.newHash, sha256Hex("new\nline\n"));
  assert.match(out.diff, /^-old$/m);
  assert.match(out.diff, /^\+new$/m);
  // 同目录临时文件已被 rename 或清理,不留残余
  assert.deepEqual(fs.readdirSync(dir), ["a.txt"]);
});

test("preserveLineEndings keeps CRLF intact (rollback path)", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.gd");
  fs.writeFileSync(file, "extends Node\n");
  const out = await safeWriteFile(file, "extends Node\r\n# keep\r\n", { preserveLineEndings: true });
  assert.equal(out.changed, true);
  assert.deepEqual(fs.readFileSync(file), Buffer.from("extends Node\r\n# keep\r\n", "utf8"));
  assert.equal(sha256Hex(fs.readFileSync(file)), out.newHash);
});

test("creates missing parent directories and new files", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "sub", "deep", "new.tscn");
  const out = await safeWriteFile(file, "[gd_scene]\n");
  assert.equal(out.changed, true);
  assert.equal(fs.readFileSync(file, "utf8"), "[gd_scene]\n");
});

test("unchanged content is a no-op with an empty diff", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "same\n");
  const out = await safeWriteFile(file, "same\n");
  assert.equal(out.changed, false);
  assert.equal(out.diff, "");
});

test("dryRun computes changed/diff but does not touch the disk", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "old\n");
  const out = await safeWriteFile(file, "new\n", { dryRun: true });
  assert.equal(out.changed, true);
  assert.match(out.diff, /^\+new$/m);
  assert.equal(fs.readFileSync(file, "utf8"), "old\n");
  assert.deepEqual(fs.readdirSync(dir), ["a.txt"]);

  const dryNew = await safeWriteFile(path.join(dir, "b.txt"), "new\n", { dryRun: true });
  assert.equal(dryNew.changed, true);
  assert.equal(fs.existsSync(path.join(dir, "b.txt")), false);
});

test("expectedHash guards against external changes", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "old\n");
  const hash = sha256Hex("old\n");

  const ok = await safeWriteFile(file, "new\n", { expectedHash: hash });
  assert.equal(ok.changed, true);
  assert.equal(fs.readFileSync(file, "utf8"), "new\n");

  await assert.rejects(
    () => safeWriteFile(file, "other\n", { expectedHash: hash }),
    (e: unknown) => e instanceof GodotMcpError && e.code === "FILE_CHANGED" && e.details?.["actualHash"] === sha256Hex("new\n"),
  );
  // 文件不存在时 expectedHash 也视为不匹配
  await assert.rejects(
    () => safeWriteFile(path.join(dir, "missing.txt"), "x\n", { expectedHash: hash }),
    (e: unknown) => e instanceof GodotMcpError && e.code === "FILE_CHANGED" && e.details?.["actualHash"] === null,
  );
});

test("a failed write leaves no temp file and keeps the original", async () => {
  const dir = tmpdir();
  const blocked = path.join(dir, "blocked");
  fs.mkdirSync(blocked); // 目标是目录 → rename 必然失败
  await assert.rejects(
    () => safeWriteFile(blocked, "x\n"),
    (e: unknown) => e instanceof GodotMcpError && e.code === "INVALID_ARGUMENT",
  );
  assert.equal(fs.statSync(blocked).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(dir), ["blocked"]);
});

test("normalizeEol converts CRLF and lone CR", () => {
  assert.equal(normalizeEol("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

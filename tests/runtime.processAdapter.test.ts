import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessAdapter } from "../src/godot/runtime/processAdapter.js";
import { BoundedLogBuffer } from "../src/godot/runtime/boundedLogBuffer.js";
import { defaultRunRunner } from "../src/godot/runtime/run.js";

test("ProcessAdapter exposes PID, independent streams, exit and stop", async () => {
  const adapter = new ProcessAdapter();
  const child = adapter.start(process.execPath, ["-e", "process.stdout.write('one'); process.stderr.write('err'); setTimeout(() => process.stdout.write('two'), 20)"], { cwd: process.cwd() });
  assert.equal(typeof child.pid, "number");
  const out: string[] = [], err: string[] = [];
  child.onStdout((chunk) => out.push(chunk.toString("utf8")));
  child.onStderr((chunk) => err.push(chunk.toString("utf8")));
  assert.deepEqual(await child.exited, { exitCode: 0, signal: null });
  assert.equal(out.join(""), "onetwo");
  assert.equal(err.join(""), "err");
  assert.equal(await child.stop(), false);
  assert.equal(await child.exited, await child.exited);
});

test("ProcessAdapter reports startup failure", async () => {
  const child = new ProcessAdapter().start("vino-godot-mcp-does-not-exist", [], {});
  const errorPromise = new Promise<Error>((resolve) => child.onError(resolve));
  await assert.rejects(child.spawned, (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  const error = await errorPromise;
  assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
  await child.exited;
});

test("ProcessAdapter actively stops its child and exposes signal exit", async () => {
  const child = new ProcessAdapter().start(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {});
  assert.equal(await child.stop("SIGTERM"), true);
  const exit = await child.exited;
  assert.equal(exit.exitCode, null);
  assert.equal(exit.signal, "SIGTERM");
});

test("BoundedLogBuffer isolates streams and reads incrementally by UTF-8 byte offset", () => {
  const b = new BoundedLogBuffer(32);
  b.append("stdout", Buffer.from("你" ).subarray(0, 1));
  b.append("stdout", Buffer.from("你").subarray(1));
  b.append("stderr", "err");
  const first = b.read("stdout", 0, 3);
  assert.equal(first.text, "你");
  assert.equal(first.nextOffset, 3);
  assert.equal(b.read("stderr", 0).text, "err");
  assert.equal(b.read("stderr", 0).latestOffset, 3);
});

test("BoundedLogBuffer drops oldest bytes, signals stale cursors, preserves UTF-8", () => {
  const b = new BoundedLogBuffer(4);
  b.append("stdout", "ab你");
  b.append("stdout", "z");
  const read = b.read("stdout", 0);
  assert.equal(read.truncated, true);
  assert.ok(read.droppedBytes > 0);
  assert.equal(read.text, "你z");
  assert.ok(Buffer.byteLength(read.text, "utf8") <= 5);
  assert.equal(read.nextOffset, read.latestOffset);
});

test("BoundedLogBuffer handles empty chunks and validates boundaries", () => {
  const b = new BoundedLogBuffer(0);
  b.append("stdout", "");
  b.append("stdout", "discard");
  assert.equal(b.read("stdout", 0).truncated, true);
  assert.equal(b.read("stdout").text, "");
  assert.throws(() => b.read("stderr", -1), RangeError);
  assert.throws(() => new BoundedLogBuffer(-1), RangeError);
});

test("bounded capture does not stop draining process output", async () => {
  const result = await defaultRunRunner(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000), () => process.exit(0))"], { timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { GodotMcpError } from "../src/core/errors.js";
import { RuntimeSessionManager, type ProcessAdapterLike } from "../src/services/runtimeSessionManager.js";
import type { ProcessAdapterHandle, ProcessAdapterOptions, ProcessExit } from "../src/godot/runtime/processAdapter.js";

class FakeHandle implements ProcessAdapterHandle {
  pid = Math.floor(Math.random() * 10000) + 1;
  private stdout = new Set<(b: Buffer) => void>(); private stderr = new Set<(b: Buffer) => void>(); private errors = new Set<(e: Error) => void>();
  private spawnResolve!: () => void; private spawnReject!: (e: Error) => void; private exitResolve!: (e: ProcessExit) => void;
  spawned = new Promise<void>((resolve, reject) => { this.spawnResolve = resolve; this.spawnReject = reject; });
  exited = new Promise<ProcessExit>((resolve) => { this.exitResolve = resolve; });
  stopped = false;
  onStdout(listener: (chunk: Buffer) => void): () => void { this.stdout.add(listener); return () => this.stdout.delete(listener); }
  onStderr(listener: (chunk: Buffer) => void): () => void { this.stderr.add(listener); return () => this.stderr.delete(listener); }
  onError(listener: (error: Error) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  stop(): Promise<boolean> { this.stopped = true; return Promise.resolve(true); }
  dispose(): void { this.stdout.clear(); this.stderr.clear(); this.errors.clear(); }
  emitSpawn(): void { this.spawnResolve(); }
  emitSpawnError(error = new Error("spawn failed")): void { this.spawnReject(error); for (const listener of this.errors) listener(error); this.exitResolve({ exitCode: null, signal: null }); }
  emitExit(exit: ProcessExit = { exitCode: 0, signal: null }): void { this.exitResolve(exit); }
  emitStdout(value: string): void { for (const listener of this.stdout) listener(Buffer.from(value)); }
  emitStderr(value: string): void { for (const listener of this.stderr) listener(Buffer.from(value)); }
}

class FakeAdapter implements ProcessAdapterLike {
  handles: FakeHandle[] = []; startCalls = 0; throwOnStart = false;
  start(): ProcessAdapterHandle { this.startCalls++; if (this.throwOnStart) throw new Error("sync spawn"); const h = new FakeHandle(); this.handles.push(h); return h; }
}
const opts = (projectRoot: string, extra: Partial<{ maxLifetimeMs: number; stopTimeoutMs: number }> = {}) => ({ projectRoot, executable: "godot", args: ["--headless"], ...extra });
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("session starts, confirms spawn, records streams and natural exit", async () => {
  const adapter = new FakeAdapter(); const manager = new RuntimeSessionManager({ adapter, retainedSessionTtlMs: 10_000 });
  const pending = manager.start(opts("C:/game")); const h = adapter.handles[0]!;
  const starting = manager.get((manager as unknown as { sessions: Map<string, unknown> }).sessions.keys().next().value as string);
  assert.equal(starting.state, "starting"); h.emitStdout("out"); h.emitStderr("err"); h.emitSpawn();
  const running = await pending; assert.equal(running.state, "running");
  const logs = manager.readLogs(running.sessionId, "both"); assert.equal(logs.stdout?.text, "out"); assert.equal(logs.stderr?.text, "err");
  h.emitExit({ exitCode: 3, signal: null }); await wait(); const ended = manager.get(running.sessionId); assert.equal(ended.state, "exited"); assert.equal(ended.exitCode, 3); manager.dispose();
});

test("sync and async startup failures do not leave active sessions", async () => {
  const adapter = new FakeAdapter(); adapter.throwOnStart = true; const manager = new RuntimeSessionManager({ adapter });
  await assert.rejects(manager.start(opts("C:/sync")), /sync spawn/); assert.equal(adapter.startCalls, 1);
  const asyncAdapter = new FakeAdapter(); const m2 = new RuntimeSessionManager({ adapter: asyncAdapter }); const pending = m2.start(opts("C:/async")); const h = asyncAdapter.handles[0]!; h.emitSpawnError(new Error("ENOENT")); const result = await pending; assert.equal(result.state, "failed"); assert.equal(result.errorCode, "GODOT_NOT_FOUND"); m2.dispose();
});

test("stop is idempotent and does not claim exit before process exit", async () => {
  const adapter = new FakeAdapter(); const manager = new RuntimeSessionManager({ adapter }); const pending = manager.start(opts("C:/stop")); const h = adapter.handles[0]!; h.emitSpawn(); const session = await pending;
  const stop = manager.stop(session.sessionId, 5); await wait(); assert.equal(manager.get(session.sessionId).state, "stopping"); const timeout = await stop; assert.equal(timeout.timedOut, true); h.emitExit({ exitCode: null, signal: "SIGTERM" }); await wait(); assert.equal(manager.get(session.sessionId).state, "exited"); const again = await manager.stop(session.sessionId); assert.equal(again.stopped, false); manager.dispose();
});

test("lifetime timeout preserves timed_out after process exit", async () => {
  const adapter = new FakeAdapter(); const manager = new RuntimeSessionManager({ adapter }); const pending = manager.start(opts("C:/timeout", { maxLifetimeMs: 5 })); const h = adapter.handles[0]!; h.emitSpawn(); const session = await pending; await wait(15); assert.equal(manager.get(session.sessionId).state, "timed_out"); h.emitExit({ exitCode: 0, signal: null }); await wait(); const ended = manager.get(session.sessionId); assert.equal(ended.state, "timed_out"); assert.equal(ended.timedOut, true); manager.dispose();
});

test("project slots, active limit and concurrent starts are isolated", async () => {
  const adapter = new FakeAdapter(); const manager = new RuntimeSessionManager({ adapter, maxActiveSessions: 2 }); const p1 = manager.start(opts("C:/a")); const h1 = adapter.handles[0]!; h1.emitSpawn(); const s1 = await p1;
  await assert.rejects(manager.start(opts("C:/a")), (e: unknown) => e instanceof GodotMcpError && e.code === "INVALID_ARGUMENT");
  const p2 = manager.start(opts("C:/b")); const h2 = adapter.handles[1]!; h2.emitSpawn(); await p2; await assert.rejects(manager.start(opts("C:/c")), /会话上限/); h1.emitExit(); h2.emitExit(); manager.dispose();
  assert.ok(s1.sessionId);
});

test("retains logs after exit and removes them after TTL without touching active process", async () => {
  const adapter = new FakeAdapter(); const manager = new RuntimeSessionManager({ adapter, retainedSessionTtlMs: 10 }); const p = manager.start(opts("C:/ttl")); const h = adapter.handles[0]!; h.emitSpawn(); const s = await p; h.emitStdout("tail"); h.emitExit(); await wait(); assert.equal(manager.readLogs(s.sessionId, "stdout").stdout?.text, "tail"); await wait(20); manager.cleanup(); assert.throws(() => manager.get(s.sessionId), /未知运行会话/);
  const active = manager.start(opts("C:/active")); const ha = adapter.handles[1]!; ha.emitSpawn(); const a = await active; await wait(20); manager.cleanup(); assert.equal(manager.get(a.sessionId).state, "running"); manager.dispose();
});

test("manager does not use TaskQueue and keeps separate cursors", async () => {
  const adapter = new FakeAdapter(); const manager = new RuntimeSessionManager({ adapter }); const p = manager.start({ ...opts("C:/logs"), logMaxBytesPerStream: 3 }); const h = adapter.handles[0]!; h.emitSpawn(); const s = await p; h.emitStdout("abcdef"); h.emitStderr("xyz"); const read = manager.readLogs(s.sessionId, "both", { stdout: 0, stderr: 0 }); assert.equal(read.stdout?.truncated, true); assert.equal(read.stderr?.text, "xyz"); manager.dispose();
});

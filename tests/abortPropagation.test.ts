// T07:MCP 请求取消 → ToolHost → handler → TaskQueue 的完整传播。
//
// 用 InMemoryTransport 起一个真实的 McpServer(与 sdkServer.ts 相同的 20 行适配),
// 所以测的是真实 SDK 的 notifications/cancelled 路径,而不是自己模拟的 EventEmitter。
// 仍然是进程内测试:不启动 Godot,不代表真实引擎行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { LockManager } from "../src/core/concurrency/lockManager.js";
import { TaskQueue } from "../src/core/concurrency/taskQueue.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { toMcpContent } from "../src/mcp/server/toolHost.js";
import { toSdkToolSchema } from "../src/mcp/server/sdkServer.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { createLogger } from "../src/core/logger.js";
import type { ToolDefinition, ToolResult } from "../src/types/index.js";

const quiet = createLogger("error", () => {});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx { runQueue: TaskQueue }

/** 一个"长任务":只有 abort 或 5s 兜底才会结束,行为与 defaultRunRunner 的等待方式一致。 */
function longTool(name: string, seen: AbortSignal[]): ToolDefinition<Ctx> {
  return {
    name, domain: "utility", description: "long", inputSchema: { type: "object", properties: {} },
    annotations: { readOnly: true }, dependency: "none", runtimeRequired: false,
    async handler(_args, ctx, exec) {
      const signal = exec?.signal;
      if (signal) seen.push(signal);
      await ctx.runQueue.runExclusive("/proj", { tool: name, target: "scene" }, async (taskSignal) => {
        await new Promise<void>((resolve) => {
          taskSignal.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 5_000).unref();
        });
      }, { ...(signal ? { signal } : {}) });
      return { data: { done: true } };
    },
  };
}

async function startPair(defs: ToolDefinition<Ctx>[]): Promise<{
  client: Client; host: ToolHost<Ctx>; locks: LockManager; results: ToolResult[];
}> {
  const locks = new LockManager();
  const host = new ToolHost(new ToolRegistry<Ctx>().registerAll(defs), { runQueue: new TaskQueue(locks) }, quiet);
  const results: ToolResult[] = [];
  const server = new McpServer({ name: "cancel-test", version: "0.0.0" });
  for (const t of host.listTools()) {
    server.registerTool(
      t.name,
      { title: t.name, description: t.description, inputSchema: toSdkToolSchema(t.inputSchema) },
      async (args: Record<string, unknown>, ctx: ServerContext) => {
        const r = await host.callTool(t.name, args, { signal: ctx.mcpReq.signal });
        results.push(r);
        return toMcpContent(r);
      },
    );
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "cancel-client", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, host, locks, results };
}

test("MCP 请求取消传播到 handler 与 TaskQueue,并释放项目锁", async () => {
  const seen: AbortSignal[] = [];
  const { client, locks, results } = await startPair([longTool("utility_long", seen)]);
  const ctrl = new AbortController();
  const pending = client.callTool({ name: "utility_long", arguments: {} }, { signal: ctrl.signal });
  await wait(20);
  ctrl.abort(new Error("client-cancel"));

  await assert.rejects(pending, (e: unknown) => {
    assert.match(String((e as Error).message), /client-cancel/);
    return true;
  });
  // SDK 不再回包,但服务端确实拿到了取消信号,并把结果记成 TASK_CANCELLED。
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.aborted, true, "ctx.mcpReq.signal 必须真的被 abort");
  assert.equal(locks.snapshot().length, 0, "取消后项目锁必须归还");
  await client.close();
});

test("同一个服务里两个并发请求的取消信号互相独立", async () => {
  const seen: AbortSignal[] = [];
  const { client, locks } = await startPair([longTool("utility_long", seen)]);
  const ctrlA = new AbortController();
  const ctrlB = new AbortController();
  const a = client.callTool({ name: "utility_long", arguments: {} }, { signal: ctrlA.signal });
  const b = client.callTool({ name: "utility_long", arguments: {} }, { signal: ctrlB.signal });
  await wait(20);
  ctrlA.abort();

  await assert.rejects(a);
  const [signalA, signalB] = [seen[0]!, seen[1]!];
  assert.notEqual(signalA, signalB, "不同请求必须各自持有 signal");
  assert.equal(signalA.aborted, true);
  assert.equal(signalB.aborted, false, "取消一个请求不能波及另一个");

  // b 拿到锁之后仍然可以正常结束(这里用取消把它收尾,顺带验证第二次取消同样干净)。
  ctrlB.abort();
  await assert.rejects(b);
  assert.equal(locks.snapshot().length, 0);
  await client.close();
});

test("正常完成不会误触发取消逻辑", async () => {
  const seen: AbortSignal[] = [];
  const defs: ToolDefinition<Ctx>[] = [{
    name: "utility_quick", domain: "utility", description: "quick", inputSchema: { type: "object", properties: {} },
    annotations: { readOnly: true }, dependency: "none", runtimeRequired: false,
    async handler(_args, _ctx, exec) { if (exec?.signal) seen.push(exec.signal); return { data: { ok: true } }; },
  }, longTool("utility_long", [])];
  const { client, results } = await startPair(defs);
  const r = await client.callTool({ name: "utility_quick", arguments: {} });
  assert.equal((r as { isError?: boolean }).isError, undefined);
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(seen[0]?.aborted, false);
  await client.close();
});

test("请求在到达 handler 前就已被取消:不执行任何实际工作", async () => {
  const seen: AbortSignal[] = [];
  const { client, locks } = await startPair([longTool("utility_long", seen)]);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(client.callTool({ name: "utility_long", arguments: {} }, { signal: ctrl.signal }));
  await wait(30);
  assert.equal(locks.snapshot().length, 0);
  // 未进入 handler,或进入后立即以 TASK_CANCELLED 退出 —— 两种都不能留下占用。
  for (const s of seen) assert.equal(s.aborted, true);
  await client.close();
});

test("ToolHost 直接调用:已取消的 signal 不会被忽略", async () => {
  const seen: AbortSignal[] = [];
  const { host } = await startPair([longTool("utility_long", seen)]);
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await host.callTool("utility_long", {}, { signal: ctrl.signal });
  assert.equal(r.ok, false);
  assert.equal((r as { ok: false; error: { code: string } }).error.code, "TASK_CANCELLED");
  assert.equal(seen.length, 0, "入口已取消就不该进入 handler");
});

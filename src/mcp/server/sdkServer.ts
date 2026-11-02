// 全项目唯一接触 MCP SDK 的文件(tests/architecture.test.ts 强制)。
//
// SDK: `@modelcontextprotocol/server` v2(实现 MCP 2026-07-28 规范,替代 v1 的 `@modelcontextprotocol/sdk`)。
// 这里全部使用真实类型(不再用 any),契约依据 node_modules 内的 .d.mts:
//   - `McpServer.registerTool(name, config, cb)`,config.inputSchema 必须是 StandardSchemaWithJSON
//     —— 即 `~standard.validate` + `~standard.jsonSchema.input(options)`,后者用于生成 `tools/list` 的 JSON Schema。
//   - 注解字段为 readOnlyHint / destructiveHint / idempotentHint / openWorldHint。
//   - `serveStdio(factory)` 负责 era 判定:既能服务 2026-07-28 客户端,也兼容 2025 老客户端(默认 legacy:'serve'),
//     比手工 `new StdioServerTransport()` + `server.connect()` 兼容性更好,且由它托管 transport 生命周期。
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { JsonSchema, Logger } from "../../types/index.js";
import { toMcpContent, type ToolHost } from "./toolHost.js";

export interface ServerInfo { name: string; version: string }

/** 工具入参在 SDK 侧的类型:普通对象进,普通对象出。 */
type ToolArgs = Record<string, unknown>;
type ToolArgsSchema = StandardSchemaWithJSON<ToolArgs, ToolArgs>;

export async function startSdkServer<Ctx>(host: ToolHost<Ctx>, info: ServerInfo, logger: Logger): Promise<void> {
  const count = host.listTools().length;
  serveStdio(
    () => {
      const server = new McpServer({ name: info.name, version: info.version });
      for (const t of host.listTools()) {
        server.registerTool(
          t.name,
          {
            title: t.name,
            description: t.description,
            inputSchema: toSdkToolSchema(t.inputSchema),
            annotations: {
              readOnlyHint: t.annotations.readOnly,
              destructiveHint: t.annotations.destructive ?? false,
              idempotentHint: t.annotations.idempotent ?? false,
            },
          },
          async (args: ToolArgs) => toMcpContent(await host.callTool(t.name, args)),
        );
      }
      return server;
    },
    { onerror: (e) => logger.error("stdio transport error", e.message) },
  );
  logger.info(`MCP server "${info.name}@${info.version}" listening on stdio, ${count} tools exposed`);
}

/**
 * 项目自有的 JsonSchema 子集(core/validation/schema.ts 的校验器) → SDK 要求的 Standard Schema。
 *
 * 两点必须说清楚:
 * 1. `jsonSchema.input()` 原样返回我们的 JSON Schema,`tools/list` 才能把参数结构告诉客户端。
 * 2. `validate` 故意**不做拒绝**:入参校验的唯一权威是 ToolHost,这样
 *    INVALID_ARGUMENT 才能保持项目统一的 `{ ok:false, error:{ code, message, details } }` 信封。
 *    若在这里真校验,SDK 会先于 ToolHost 用自己的错误格式返回,破坏统一错误结构。
 *    handler 拿到的参数一定已经过 ToolHost 校验,不存在"未校验就执行"的风险。
 */
export function toSdkToolSchema(json: JsonSchema): ToolArgsSchema {
  const asRecord = json as unknown as Record<string, unknown>;
  // Standard Schema 的 `types` 是纯类型标记,值本身无意义;给出它才能让 SDK 推导出 handler 的参数类型。
  const types = { input: {} as ToolArgs, output: {} as ToolArgs };
  return {
    "~standard": {
      version: 1,
      vendor: "vino-godot-mcp",
      types,
      validate: (value: unknown) => ({ value: (value ?? {}) as ToolArgs }),
      jsonSchema: {
        input: () => asRecord,
        output: () => asRecord,
      },
    },
  };
}

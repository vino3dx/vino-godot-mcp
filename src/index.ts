#!/usr/bin/env node
// 组合根:唯一同时认识所有层的地方,同时也是 CLI 入口(--version / --help)。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GodotMcpError } from "./core/errors.js";
import { createLogger } from "./core/logger.js";
import { ToolRegistry } from "./mcp/registry/toolRegistry.js";
import { describeToolSelection, resolveToolSelection } from "./mcp/registry/toolSelection.js";
import { ToolHost } from "./mcp/server/toolHost.js";
import { startSdkServer } from "./mcp/server/sdkServer.js";
import { createAppContext, type AppContext } from "./services/context.js";
import { allTools } from "./tools/index.js";

/** CLI 命令名(package.json 的 bin 键),与 npm 包名 `vino-godot-mcp` 一致。 */
export const CLI_NAME = "vino-godot-mcp";

/**
 * 版本号唯一来源:package.json。
 * 编译产物位于 dist/src/index.js,所以从本文件向上一级即仓库根目录。
 */
function readPackageVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json is missing a valid \"version\" field");
  }
  return version;
}

export const VERSION = readPackageVersion();
export const SERVER_INFO: { name: string; version: string } = { name: CLI_NAME, version: VERSION };

/**
 * 组合根:读取工具暴露策略(preset ∩ groups)后再注册。
 * 筛选在注册之前完成,所以被排除的工具对 MCP 客户端完全不可见。
 * env 可注入,便于测试;诊断信息只写 stderr(由 logger 保证)。
 */
export function buildHost(logger = createLogger(), env: Readonly<Record<string, string | undefined>> = process.env): ToolHost<AppContext> {
  const selection = resolveToolSelection(allTools, env);
  // info 级别:启动时就能看到生效的 preset / groups / 最终工具数(stderr,不影响协议)。
  logger.info(describeToolSelection(selection, allTools.length));
  const registry = new ToolRegistry<AppContext>().registerAll(selection.tools);
  return new ToolHost(registry, createAppContext(logger), logger, selection.domains);
}

async function main(): Promise<void> {
  const logger = createLogger();
  await startSdkServer(buildHost(logger), SERVER_INFO, logger);
}

/** CLI 动作:无参数启动 MCP 服务,其余为自检/输出。 */
export type CliAction =
  | { kind: "serve" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "unknown"; arg: string };

/** 只看第一个参数:版本/帮助优先,其余一律视为未知参数(不做位置参数)。 */
export function parseCliArgs(argv: readonly string[]): CliAction {
  const first = argv.find((a) => a.trim() !== "");
  if (first === undefined) return { kind: "serve" };
  const arg = first.trim();
  if (arg === "--version" || arg === "-v") return { kind: "version" };
  if (arg === "--help" || arg === "-h") return { kind: "help" };
  return { kind: "unknown", arg };
}

export function versionText(): string {
  return `${CLI_NAME} ${VERSION}`;
}

export function helpText(): string {
  return [
    versionText(),
    "",
    "Vino Godot MCP — MCP server for the Godot engine (Model Context Protocol, stdio transport).",
    "",
    "Usage:",
    `  ${CLI_NAME}                 Start the MCP stdio server (launched by your AI client)`,
    `  ${CLI_NAME} --version, -v   Print the version and exit`,
    `  ${CLI_NAME} --help, -h      Print this help and exit`,
    "",
    "Running it by hand:",
    "  The server speaks JSON-RPC over stdin/stdout. Started from a terminal it prints one",
    "  line to stderr and then waits for input; that is normal, not a hang. Logs always go",
    "  to stderr, stdout belongs to the MCP protocol. Ctrl+C to quit.",
    "",
    "npm package: vino-godot-mcp   (npx -y vino-godot-mcp)",
    "Docs: https://github.com/vino3dx/vino-godot-mcp#readme",
    "",
  ].join("\n");
}

export function runCli(argv: readonly string[]): void {
  const action = parseCliArgs(argv);
  switch (action.kind) {
    case "version":
      process.stdout.write(`${versionText()}\n`);
      return;
    case "help":
      process.stdout.write(helpText());
      return;
    case "unknown":
      process.stderr.write(`[${CLI_NAME}] unknown argument "${action.arg}"\n[${CLI_NAME}] try "${CLI_NAME} --help"\n`);
      process.exitCode = 2;
      return;
    case "serve":
      main().catch((e) => {
        // 配置错误(未知 preset/group、空工具集)是可预期的:打印稳定错误码,不打整段 stack。
        if (e instanceof GodotMcpError) {
          process.stderr.write(`[${CLI_NAME}] fatal: ${e.code}: ${e.message}\n`);
          process.exit(1);
        }
        process.stderr.write(`[${CLI_NAME}] fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
        process.exit(1);
      });
      return;
  }
}

/** 仅在作为入口直接运行时启动(被测试/dev-cli import 时不动)。 */
function isEntry(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntry()) runCli(process.argv.slice(2));

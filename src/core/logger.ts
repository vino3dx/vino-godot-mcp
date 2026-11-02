import type { Logger } from "../types/index.js";

// 日志一律写 stderr:stdio 传输下 stdout 属于 MCP 协议,绝不能被污染。
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  level: LogLevel = (process.env["VINO_GODOT_MCP_LOG"] as LogLevel | undefined) ?? "info",
  sink: (line: string) => void = (l) => { process.stderr.write(l + "\n"); },
): Logger {
  const min = ORDER[level] ?? ORDER.info;
  const emit = (lv: LogLevel) => (msg: string, meta?: unknown) => {
    if (ORDER[lv] < min) return;
    sink(`[vino-godot-mcp] ${lv.toUpperCase()} ${msg}${meta === undefined ? "" : " " + JSON.stringify(meta)}`);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

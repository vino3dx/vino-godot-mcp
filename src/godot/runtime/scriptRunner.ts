// 内部助手:临时 GDScript 的生命周期 + 引擎脚本回传结果的解析。
//
// 复用者:runtimeService.captureScreenshot / runtimeService.inspectUi。
// 这两条路都要"写一段 GDScript 到系统 temp → godot --script 运行 → 收集 stdout → 删除临时文件";
// 差异只在脚本内容与参数,故把共用部分收在这里。**不对外暴露成 MCP 工具,也不提供"运行任意脚本"的口子。**
//
// 结果回传约定(真实 Godot 4.6.3 实测:print 一次即 stdout 一整行,不会被引擎折行):
//   引擎脚本把结构化结果以单行 `MCP_RESULT_JSON=<json>` 打到 stdout;
//   助手只认这一行,其余引擎日志(版本横幅 / OpenGL 信息 / push_error)一概忽略。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 引擎脚本回传结构化结果的单行前缀。 */
export const MCP_RESULT_PREFIX = "MCP_RESULT_JSON=";

/** 临时 GDScript 的落盘目录(系统临时目录下,绝不写进用户工程)。 */
export const TEMP_SCRIPT_DIR = path.join(os.tmpdir(), "vino-godot-mcp");

export interface TempScriptOptions {
  /** 文件名前缀,便于人工定位遗留文件(默认 "mcp")。 */
  prefix?: string;
}

/**
 * 写临时 GDScript(系统临时目录下唯一文件名)→ 交给 run 用 --script 执行 → 无论成败都删除脚本文件。
 *
 * "收集 stdout" 由 run 负责(调用方传入的通常是 RuntimeService.execute 的结果);
 * 本助手只管临时文件的生灭,不碰进程、队列与错误码。
 */
export async function withTempScript<T>(
  script: string,
  run: (scriptPath: string) => Promise<T>,
  opts: TempScriptOptions = {},
): Promise<T> {
  const scriptPath = path.join(TEMP_SCRIPT_DIR, `${opts.prefix ?? "mcp"}-${randomUUID()}.gd`);
  fs.mkdirSync(TEMP_SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(scriptPath, script, "utf8");
  try {
    return await run(scriptPath);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
}

export type McpResultParse =
  | { ok: true; value: unknown }
  | { ok: false; reason: "missing" | "invalid_json"; message: string };

/**
 * 从 stdout 里取**最后一行** `MCP_RESULT_JSON=<json>` 并 JSON.parse。
 * 取最后一行:脚本自己回传的结果一定在最后,前面若出现同前缀的行(例如脚本把要打印的 payload
 * 先 echo 了一遍,或引擎/日志回显)只应视为干扰,不能抢先当成结果。
 * 缺失前缀或 JSON 非法都返回结构化错误(调用方负责转成 GodotMcpError),不抛异常。
 */
export function parseMcpResultJson(stdout: string): McpResultParse {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith(MCP_RESULT_PREFIX));
  const line = lines.at(-1);
  if (line === undefined) {
    return { ok: false, reason: "missing", message: `Engine stdout has no line starting with ${MCP_RESULT_PREFIX}` };
  }
  const raw = line.slice(MCP_RESULT_PREFIX.length).trim();
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (e) {
    return {
      ok: false,
      reason: "invalid_json",
      message: `Malformed JSON after ${MCP_RESULT_PREFIX}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

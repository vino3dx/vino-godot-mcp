import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const runtimeGetVersion: ToolDefinition<AppContext> = {
  name: "runtime_get_version",
  domain: "runtime",
  description:
    "Detect the installed Godot CLI (GODOT_PATH, then PATH) and return its real `--version` output. " +
    "Takes no parameters. Fails with GODOT_NOT_FOUND / GODOT_PROCESS_FAILED instead of guessing the version.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnly: true, idempotent: true },
  // 一次性 CLI 探测,不需要常驻 Runtime Adapter;该字段当前只是元数据,不影响执行门槛。
  runtimeRequired: false,
  dependency: "godot",
  async handler(_args, ctx) {
    return { data: await ctx.godot.getVersion() };
  },
};

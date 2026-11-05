import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const utilityTaskStatus: ToolDefinition<AppContext> = {
  name: "utility_task_status",
  domain: "utility",
  description: "List tasks currently holding or waiting for a file/project lock (who is running, for how long, who is queued).",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(_args, ctx) {
    return { data: ctx.status.getTaskStatus() };
  },
};

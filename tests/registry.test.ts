import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, parseEnabledDomains } from "../src/mcp/registry/toolRegistry.js";
import type { ToolDefinition } from "../src/types/index.js";

const mk = (name: string, domain: ToolDefinition["domain"] = "utility"): ToolDefinition => ({
  name, domain, description: "d", inputSchema: { type: "object" }, annotations: { readOnly: true }, dependency: "none", runtimeRequired: false,
  handler: async () => ({ data: 1 }),
});

test("register + duplicate + naming rules", () => {
  const r = new ToolRegistry();
  r.register(mk("utility_a"));
  assert.throws(() => r.register(mk("utility_a")), /Duplicate/);
  assert.throws(() => r.register(mk("Bad-Name")), /Invalid tool name/);
  assert.throws(() => r.register(mk("scene_create", "utility")), /must start with its domain/);
  assert.equal(r.size, 1);
});
test("domain filtering (on-demand groups)", () => {
  const r = new ToolRegistry().registerAll([mk("utility_a"), mk("scene_create", "scene")]);
  assert.equal(r.list().length, 2);
  assert.deepEqual(r.list(parseEnabledDomains("scene")).map((t) => t.name), ["scene_create"]);
  assert.equal(parseEnabledDomains(undefined).size, 0);
});

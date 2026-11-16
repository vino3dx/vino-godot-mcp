// P1-A 真实引擎验收:用真实 Godot 4.6.3 的 ClassDB dump 校验节点类型与属性。
// 覆盖:Control 合法属性、Node2D 合法属性、CanvasGroup 上的 Control 属性(必须 warning)、
// 不存在的节点类型(必须报错)、不存在的属性(必须 warning)、继承属性(合法)。
// 约定:GODOT_BIN 未设置则整组 skip;执行期间把 GODOT_PATH 指向同一可执行文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/core/logger.js";
import { ProjectResolver } from "../src/core/project/projectResolver.js";
import { createAppContext, type AppContext } from "../src/services/context.js";
import { ToolHost } from "../src/mcp/server/toolHost.js";
import { ToolRegistry } from "../src/mcp/registry/toolRegistry.js";
import { allTools } from "../src/tools/index.js";
import type { ToolResult } from "../src/types/index.js";

const GODOT_BIN = process.env["GODOT_BIN"];
const FIXTURE = path.join(import.meta.dirname!, "..", "..", "tests", "fixture_project");
const SCENE = "res://scenes/main.tscn";
const quiet = createLogger("error", () => {});

interface Host { dir: string; host: ToolHost<AppContext> }

function makeHost(t: { after: (fn: () => void) => void }): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vino-classval-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const previous = process.env["GODOT_PATH"];
  process.env["GODOT_PATH"] = GODOT_BIN!;
  t.after(() => {
    if (previous === undefined) delete process.env["GODOT_PATH"];
    else process.env["GODOT_PATH"] = previous;
  });
  const ctx = createAppContext(quiet, new ProjectResolver({ cwd: dir }));
  return { dir, host: new ToolHost(new ToolRegistry<AppContext>().registerAll(allTools), ctx, quiet) };
}

function ok(r: ToolResult): { data: Record<string, unknown>; warnings?: string[] } {
  assert.equal(r.ok, true, JSON.stringify(r));
  const success = r as { ok: true; data: Record<string, unknown>; warnings?: string[] };
  return { data: success.data, ...(success.warnings === undefined ? {} : { warnings: success.warnings }) };
}

function validationOf(data: Record<string, unknown>): Record<string, unknown> {
  const v = data["propertyValidation"] as Record<string, unknown> | undefined;
  assert.ok(v, "propertyValidation must be present");
  return v;
}

function propertyCheck(validation: Record<string, unknown>, name: string): Record<string, unknown> {
  const list = validation["properties"] as Array<Record<string, unknown>>;
  const found = list.find((p) => p["name"] === name);
  assert.ok(found, `property check for ${name} missing: ${JSON.stringify(list)}`);
  return found;
}

const skip = GODOT_BIN === undefined ? "GODOT_BIN is not set" : false;

test("Control accepts its own property and reports verified", { skip }, async (t) => {
  const { host } = makeHost(t);
  const { data, warnings } = ok(await host.callTool("scene_add_node", {
    path: SCENE, parentPath: ".", nodeType: "Control", nodeName: "Hud",
    properties: [{ name: "offset_left", value: "12.0" }],
  }));
  const v = validationOf(data);
  assert.equal(v["status"], "verified");
  assert.equal(v["source"], "classdb");
  assert.equal(data["validationSource"], "classdb");
  assert.equal(propertyCheck(v, "offset_left")["status"], "verified");
  assert.equal(warnings, undefined);
});

test("Node2D accepts position (Vector2)", { skip }, async (t) => {
  const { host } = makeHost(t);
  const { data } = ok(await host.callTool("scene_add_node", {
    path: SCENE, parentPath: ".", nodeType: "Node2D", nodeName: "Marker",
    properties: [{ name: "position", value: "Vector2(3, 4)" }],
  }));
  const v = validationOf(data);
  assert.equal(v["status"], "verified");
  assert.equal(propertyCheck(v, "position")["status"], "verified");
  assert.equal(propertyCheck(v, "position")["expectedType"], "Vector2");
});

test("CanvasGroup with Control-only properties produces explicit warnings", { skip }, async (t) => {
  const { host } = makeHost(t);
  const { data, warnings } = ok(await host.callTool("scene_add_node", {
    path: SCENE, parentPath: ".", nodeType: "CanvasGroup", nodeName: "Group",
    properties: [
      { name: "offset_left", value: "1.0" },
      { name: "mouse_filter", value: "2" },
    ],
  }));
  const v = validationOf(data);
  assert.equal(v["status"], "verified", "CanvasGroup is an instantiable Node subclass");
  assert.equal(propertyCheck(v, "offset_left")["status"], "unknown");
  assert.equal(propertyCheck(v, "mouse_filter")["status"], "unknown");
  assert.ok(warnings?.some((w) => w.includes("offset_left")), `warnings=${JSON.stringify(warnings)}`);
  assert.ok(warnings?.some((w) => w.includes("mouse_filter")));
});

test("a node type that is not in ClassDB is rejected before writing", { skip }, async (t) => {
  const { dir, host } = makeHost(t);
  const before = fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8");
  const r = await host.callTool("scene_add_node", {
    path: SCENE, parentPath: ".", nodeType: "NotARealNodeClass", nodeName: "Nope",
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  const error = (r as { ok: false; error: { code: string; details?: Record<string, unknown> } }).error;
  assert.equal(error.code, "INVALID_ARGUMENT");
  assert.equal(error.details?.["param"], "nodeType");
  assert.equal(fs.readFileSync(path.join(dir, "scenes", "main.tscn"), "utf8"), before, "must not write on a rejected class");
});

test("an unknown property on an existing class is a warning, not a silent pass", { skip }, async (t) => {
  const { host } = makeHost(t);
  const { data, warnings } = ok(await host.callTool("scene_add_node", {
    path: SCENE, parentPath: ".", nodeType: "Control", nodeName: "Hud2",
    properties: [{ name: "definitely_not_a_property", value: "1" }],
  }));
  const v = validationOf(data);
  assert.equal(propertyCheck(v, "definitely_not_a_property")["status"], "unknown");
  assert.ok(warnings?.some((w) => w.includes("definitely_not_a_property")));
});

test("inherited properties are accepted and report their declaring class", { skip }, async (t) => {
  const { host } = makeHost(t);
  const { data } = ok(await host.callTool("scene_add_node", {
    path: SCENE, parentPath: ".", nodeType: "Label", nodeName: "Title",
    properties: [{ name: "visible", value: "false" }],
  }));
  const v = validationOf(data);
  assert.equal(v["status"], "verified");
  const check = propertyCheck(v, "visible");
  assert.equal(check["status"], "verified");
  assert.equal(check["inherited"], true);
  assert.equal(typeof check["declaredBy"], "string");
});

test("an obvious literal/type mismatch is reported as a warning", { skip }, async (t) => {
  const { host } = makeHost(t);
  const { data, warnings } = ok(await host.callTool("scene_add_node", {
    path: SCENE, parentPath: ".", nodeType: "Label", nodeName: "WrongText",
    properties: [{ name: "text", value: "12345" }],
  }));
  const check = propertyCheck(validationOf(data), "text");
  assert.equal(check["status"], "type_mismatch");
  assert.equal(check["expectedType"], "String");
  assert.ok(warnings?.some((w) => w.includes("text")));
});

test("scene_update_node_property validates the node type read from the .tscn", { skip }, async (t) => {
  const { host } = makeHost(t);
  ok(await host.callTool("scene_add_node", {
    path: SCENE, parentPath: ".", nodeType: "CanvasGroup", nodeName: "Group2",
    properties: [{ name: "position", value: "Vector2(0, 0)" }],
  }));
  const updated = ok(await host.callTool("scene_update_node_property", {
    path: SCENE, nodePath: "Group2", key: "offset_top", value: "5.0",
  }));
  const check = propertyCheck(validationOf(updated.data), "offset_top");
  assert.equal(check["status"], "unknown");
  assert.ok(updated.warnings?.some((w) => w.includes("offset_top")));
});

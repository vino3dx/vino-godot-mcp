// CLI 自检(--version / --help / 未知参数)与 stdio 兼容性。
// 进程级用例直接跑编译产物 dist/src/index.js,因为 stdout/stderr 的分工只有真进程才验证得到。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, versionText, helpText, CLI_NAME, VERSION } from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));            // dist/tests
const ROOT = path.resolve(HERE, "../..");                             // 仓库根
const SERVER_ENTRY = path.resolve(HERE, "../src/index.js");           // dist/src/index.js
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
};

/** 同步跑一次 CLI,带超时(万一误启动 server 会以 timeout 而不是挂死收场)。 */
function run(args: string[]): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const r = spawnSync(process.execPath, [SERVER_ENTRY, ...args], { cwd: ROOT, encoding: "utf8", timeout: 20000 });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, timedOut };
}

// ---------- 参数解析(进程内) ----------

test("parseCliArgs: version / help / serve / unknown", () => {
  assert.deepEqual(parseCliArgs([]), { kind: "serve" });
  assert.deepEqual(parseCliArgs([""]), { kind: "serve" });
  assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
  assert.deepEqual(parseCliArgs(["-v"]), { kind: "version" });
  assert.deepEqual(parseCliArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["-h"]), { kind: "help" });
  assert.deepEqual(parseCliArgs(["--nope"]), { kind: "unknown", arg: "--nope" });
  assert.deepEqual(parseCliArgs(["list"]), { kind: "unknown", arg: "list" });
});

test("version comes from package.json, help mentions both names", () => {
  assert.equal(CLI_NAME, "godot-ai-mcp");
  assert.equal(VERSION, PKG.version);
  assert.equal(versionText(), `${CLI_NAME} ${PKG.version}`);
  // 包名与命令名不同,帮助文本必须同时给出,否则用户会以为没装好。
  assert.equal(CLI_NAME, Object.keys(PKG.bin)[0]);
  assert.ok(helpText().includes(PKG.name), "help must mention the npm package name");
  assert.ok(helpText().includes("--version"));
  assert.ok(helpText().includes("--help"));
  assert.ok(helpText().includes("stdio"));
});

// ---------- 进程级 ----------

test("--version prints CLI name + package.json version to stdout and exits 0", () => {
  const r = run(["--version"]);
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `godot-ai-mcp ${PKG.version}\n`);
  assert.equal(r.stderr, "", "version output must not leak logs to stderr");
});

test("-v behaves exactly like --version", () => {
  const short = run(["-v"]);
  const long = run(["--version"]);
  assert.equal(short.status, 0);
  assert.equal(short.stdout, long.stdout);
  assert.equal(short.stderr, "");
});

test("--help prints usage to stdout and exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^godot-ai-mcp \d+\.\d+\.\d+\n/);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--version, -v/);
  assert.match(r.stdout, /--help, -h/);
  assert.match(r.stdout, /npx -y vino-godot-mcp/);
  assert.match(r.stdout, /stdin|stdout|JSON-RPC/);
  assert.equal(r.stderr, "");
});

test("-h behaves exactly like --help", () => {
  const short = run(["-h"]);
  const long = run(["--help"]);
  assert.equal(short.status, 0);
  assert.equal(short.stdout, long.stdout);
});

test("--version / --help never start the MCP server", () => {
  for (const args of [["--version"], ["-v"], ["--help"], ["-h"]]) {
    const r = run(args);
    assert.equal(r.timedOut, false, `${args.join(" ")} should exit by itself`);
    assert.doesNotMatch(r.stderr, /listening on stdio/, `${args.join(" ")} must not boot the server`);
    assert.doesNotMatch(r.stdout, /listening on stdio/);
    // 没有任何 JSON-RPC 帧:旧版本若启动 server,stdout 会立刻出现协议数据。
    assert.doesNotMatch(r.stdout, /"jsonrpc"/);
  }
});

test("unknown argument exits non-zero with a hint, without touching stdout", () => {
  const r = run(["--nope"]);
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /unknown argument "--nope"/);
  assert.match(r.stderr, /--help/);
});

test("no arguments still boots the stdio server and keeps stdout protocol-clean", async (t) => {
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill(); });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
  child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !/listening on stdio/.test(stderr)) {
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.match(stderr, /listening on stdio, \d+ tools exposed/, `server never announced itself; stderr=${stderr}`);
  assert.equal(stdout, "", "stdout must stay empty until the client sends a request");
  child.stdin.end();
});

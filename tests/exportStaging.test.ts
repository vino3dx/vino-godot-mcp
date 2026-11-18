// T07-C1:导出提交阶段的安全替换。
//
// 这一组不与 Godot 交互:用真实文件系统 + 可注入的 fs 操作,制造"跨盘复制失败 / 替换失败 /
// 备份删不掉"这些在单机上无法稳定复现的情况。
// 核心契约:**正式目标在新产物完整准备好之前不变**,替换失败必须尽量回滚并把残留交代清楚。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GodotMcpError } from "../src/core/errors.js";
import { commitExportStaging, createExportStaging, type ExportFsOps } from "../src/services/exportStaging.js";

const errno = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: ${message}`), { code });

/** 默认走真实 fs;每个用例只覆盖需要"坏掉"的那一步。 */
function ops(over: Partial<ExportFsOps> = {}): ExportFsOps {
  return {
    existsSync: (p) => fs.existsSync(p),
    renameSync: (from, to) => fs.renameSync(from, to),
    cpSync: (from, to) => fs.cpSync(from, to, { recursive: true }),
    rmSync: (p) => fs.rmSync(p, { recursive: true, force: true }),
    ...over,
  };
}

/** 造一个"staging 已在临时目录、旧构建已在正式路径"的现场。 */
function scene(t: { after: (fn: () => void) => void }, oldBuild: string | null, newBuild = "NEW"): {
  dir: string; target: string; staging: ReturnType<typeof createExportStaging>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t07c1-export-"));
  const target = path.join(dir, "build", "game.exe");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (oldBuild !== null) fs.writeFileSync(target, oldBuild);
  const staging = createExportStaging(target);
  fs.writeFileSync(staging.stagingOutputPath, newBuild);
  // staging 在系统临时目录,失败用例会刻意把它留下(那是被测行为),这里只负责测试后收尾。
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(staging.stagingDir, { recursive: true, force: true });
  });
  return { dir, target, staging };
}

/** 目标目录里除正式产物外不允许留下辅助文件(.new- / .old-)。 */
function helpers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes(".new-") || n.includes(".old-"));
}

function capture(fn: () => void): unknown {
  try { fn(); } catch (e) { return e; }
  assert.fail("expected the commit to throw");
}

test("同盘提交:rename 直接替换,旧构建被新产物覆盖,无辅助文件残留", (t) => {
  const { target, staging } = scene(t, "OLD");

  const r = commitExportStaging(staging);

  assert.equal(r.committed, true);
  assert.deepEqual(r.moved, [target]);
  assert.deepEqual(r.warnings, []);
  assert.equal(fs.readFileSync(target, "utf8"), "NEW");
  assert.deepEqual(helpers(path.dirname(target)), [], "不允许留下 .new- / .old- 辅助文件");
  assert.equal(fs.existsSync(staging.stagingDir), false, "staging 目录应被清掉");
});

test("跨盘提交(强制 EXDEV):先在目标盘落副本,再替换,旧构建不丢", (t) => {
  const { target, staging } = scene(t, "OLD");
  const copied: string[] = [];

  const r = commitExportStaging(staging, ops({
    // 只让 staging → 目标目录 的那一次 rename 失败,模拟跨盘。
    renameSync: (from, to) => {
      if (from.startsWith(staging.stagingDir)) throw errno("EXDEV");
      return fs.renameSync(from, to);
    },
    cpSync: (from, to) => { copied.push(to); fs.cpSync(from, to, { recursive: true }); },
  }));

  assert.equal(r.committed, true);
  assert.equal(fs.readFileSync(target, "utf8"), "NEW");
  assert.equal(copied.length, 1, "跨盘只复制一次");
  // 复制目标是正式目录里的临时名,不是正式名 —— 正式名前一刻还挂着旧构建。
  assert.equal(path.dirname(copied[0]!), path.dirname(target));
  assert.match(path.basename(copied[0]!), /^\.game\.exe\.new-/);
  assert.deepEqual(helpers(path.dirname(target)), [], "提交成功后辅助文件必须被清理");
  assert.equal(fs.existsSync(staging.stagingDir), false);
});

test("跨盘复制失败:旧构建完整保留,错误里说明卡在准备阶段", (t) => {
  const { target, staging } = scene(t, "OLD");

  const e = capture(() => commitExportStaging(staging, ops({
    renameSync: (from, to) => {
      if (from.startsWith(staging.stagingDir)) throw errno("EXDEV");
      return fs.renameSync(from, to);
    },
    cpSync: () => { throw errno("ENOSPC", "no space left on device"); },
  })));

  assert.ok(e instanceof GodotMcpError);
  assert.equal(e.code, "RUNTIME_FAILED");
  assert.equal(e.details?.["phase"], "prepare");
  assert.equal(e.details?.["previousBuildRestored"], true, "目标根本没被碰过");
  assert.equal(fs.readFileSync(target, "utf8"), "OLD", "旧构建必须原封不动");
  assert.deepEqual(helpers(path.dirname(target)), [], "写了一半的副本必须被清掉");
  // staging 还在(半成品留在临时目录),这一点要在诊断里说清楚。
  const cleanup = e.details?.["cleanup"] as { residual: string[] };
  assert.deepEqual(cleanup.residual, [staging.stagingDir]);
});

test("备份旧目标失败:旧构建不动,新产物作为残留保留(而不是被删掉)", (t) => {
  const { target, staging } = scene(t, "OLD");

  const e = capture(() => commitExportStaging(staging, ops({
    renameSync: (from, to) => {
      if (path.basename(to).includes(".old-")) throw errno("EPERM", "operation not permitted");
      return fs.renameSync(from, to);
    },
  })));

  assert.ok(e instanceof GodotMcpError);
  assert.equal(e.details?.["phase"], "swap");
  assert.equal(e.details?.["previousBuildRestored"], true, "正式目标根本没被改名");
  assert.equal(fs.readFileSync(target, "utf8"), "OLD");
  // 同盘时 staging 里的原件已经改名成准备物,所以这条残留是新产物的唯一一份,不能被清理掉。
  const cleanup = e.details?.["cleanup"] as { residual: string[] };
  assert.equal(cleanup.residual.length, 1);
  assert.match(cleanup.residual[0]!, /\.game\.exe\.new-/);
  assert.equal(fs.readFileSync(cleanup.residual[0]!, "utf8"), "NEW");
});

test("替换失败:旧构建被回滚到原位,错误标记 restored=true", (t) => {
  const { target, staging } = scene(t, "OLD");

  const e = capture(() => commitExportStaging(staging, ops({
    renameSync: (from, to) => {
      if (from.startsWith(staging.stagingDir)) throw errno("EXDEV");
      if (path.basename(from).includes(".new-")) throw errno("EPERM", "operation not permitted");
      return fs.renameSync(from, to);
    },
  })));

  assert.ok(e instanceof GodotMcpError);
  assert.equal(e.code, "RUNTIME_FAILED");
  assert.equal(e.details?.["phase"], "swap");
  assert.equal(e.details?.["previousBuildRestored"], true, "回滚必须成功");
  assert.equal(fs.readFileSync(target, "utf8"), "OLD", "旧构建必须回到原位");
  // 走的是"复制到目标盘 → 替换失败 → 回滚",准备物留在原地并进 residual。
  const cleanup = e.details?.["cleanup"] as { residual: string[] };
  assert.equal(cleanup.residual.length, 1);
  assert.match(cleanup.residual[0]!, /\.game\.exe\.new-/);
  assert.equal(path.dirname(cleanup.residual[0]!), path.dirname(target), "残留路径必须交出来,便于手工处理");
});

test("替换失败且回滚失败:旧备份与新产物都被交出来(不谎报已恢复)", (t) => {
  const { target, staging } = scene(t, "OLD");

  const e = capture(() => commitExportStaging(staging, ops({
    renameSync: (from, to) => {
      if (from.startsWith(staging.stagingDir)) throw errno("EXDEV");
      const base = path.basename(from);
      if (base.includes(".new-") || base.includes(".old-")) throw errno("EPERM", "operation not permitted");
      return fs.renameSync(from, to);
    },
  })));

  assert.ok(e instanceof GodotMcpError);
  assert.equal(e.details?.["previousBuildRestored"], false, "回滚失败必须如实上报");
  const cleanup = e.details?.["cleanup"] as { residual: string[] };
  assert.equal(cleanup.residual.length, 2, "旧备份与新产物都要在残留里");
  assert.ok(cleanup.residual.some((p) => p.includes(".old-")));
  assert.ok(cleanup.residual.some((p) => p.includes(".new-")));
  for (const p of cleanup.residual) assert.equal(fs.existsSync(p), true, `残留路径必须真实存在: ${p}`);
  assert.equal(fs.existsSync(target), false, "此刻正式名不存在,只能靠备份恢复");
});

test("备份清理失败:提交仍然成功,但返回明确 warning 并保留备份路径", (t) => {
  const { target, staging } = scene(t, "OLD");

  const r = commitExportStaging(staging, ops({
    rmSync: (p) => {
      if (path.basename(p).includes(".old-")) throw errno("EBUSY", "resource busy");
      fs.rmSync(p, { recursive: true, force: true });
    },
  }));

  assert.equal(r.committed, true, "新产物已就位,不能因为旧备份删不掉就报失败");
  assert.equal(fs.readFileSync(target, "utf8"), "NEW");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /previous build backup could not be removed/);
  const backup = helpers(path.dirname(target)).find((n) => n.includes(".old-"));
  assert.ok(backup, "警告必须能定位到残留的备份文件");
  assert.equal(r.warnings[0]!.includes(path.join(path.dirname(target), backup!)), true);
});

test("正式路径原本不存在:直接提交,不需要备份", (t) => {
  const { target, staging } = scene(t, null);

  const r = commitExportStaging(staging);

  assert.equal(r.committed, true);
  assert.equal(fs.readFileSync(target, "utf8"), "NEW");
  assert.deepEqual(helpers(path.dirname(target)), []);
});

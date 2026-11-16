// P2-B:输出解码的确定性部分。
// 覆盖:UTF-8 中文、跨 chunk 拼接、BOM、GBK 回退、UTF-16LE、截断尾字节、结构化错误细节。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeProcessOutput, trimIncompleteUtf8Tail } from "../src/core/outputEncoding.js";
import { resolveCandidates } from "../src/godot/cli.js";

test("valid UTF-8 (including Chinese) is decoded as UTF-8", () => {
  const decoded = decodeProcessOutput(Buffer.from("中文文件名与错误信息\n", "utf8"));
  assert.equal(decoded.encoding, "utf-8");
  assert.equal(decoded.hadErrors, false);
  assert.equal(decoded.text, "中文文件名与错误信息\n");
});

test("a multi-byte character split across chunks survives concatenation", () => {
  const bytes = Buffer.from("前缀中文后缀", "utf8");
  const split = Math.floor(bytes.length / 2);
  // 直接解码单个 chunk 会得到 U+FFFD;正确做法是先拼接再解码。
  const first = decodeProcessOutput(bytes.subarray(0, split));
  assert.notEqual(first.text, "前缀中文后缀");
  const joined = decodeProcessOutput(Buffer.concat([bytes.subarray(0, split), bytes.subarray(split)]));
  assert.equal(joined.text, "前缀中文后缀");
  assert.equal(joined.encoding, "utf-8");
});

test("UTF-8 BOM is stripped", () => {
  const decoded = decodeProcessOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("场景", "utf8")]));
  assert.equal(decoded.text, "场景");
  assert.equal(decoded.encoding, "utf-8");
});

test("UTF-16LE BOM is detected", () => {
  const decoded = decodeProcessOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文", "utf16le")]));
  assert.equal(decoded.text, "中文");
  assert.equal(decoded.encoding, "utf-16le");
});

test("invalid UTF-8 falls back instead of producing replacement characters", () => {
  // GBK for 中文;在 Windows 上必须优先回退 GBK,其它平台回退 windows-1252。
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const decoded = decodeProcessOutput(gbk);
  assert.equal(decoded.hadErrors, true);
  if (process.platform === "win32") {
    assert.equal(decoded.encoding, "gbk");
    assert.equal(decoded.text, "中文");
  } else {
    assert.notEqual(decoded.encoding, "utf-8");
  }
  assert.equal(decoded.text.includes("\uFFFD"), false);
});

test("a truncated multi-byte tail is trimmed, not corrupted", () => {
  const bytes = Buffer.from("中文", "utf8"); // 6 bytes
  const cut = bytes.subarray(0, bytes.length - 1);
  assert.ok(trimIncompleteUtf8Tail(cut) !== undefined);
  const decoded = decodeProcessOutput(cut, { truncated: true });
  assert.equal(decoded.encoding, "utf-8");
  assert.equal(decoded.text, "中");
  assert.equal(decoded.text.includes("\uFFFD"), false);
});

test("missing Godot path is reported as structured data, not by parsing terminal text", () => {
  assert.throws(
    () => resolveCandidates({ env: { GODOT_PATH: "C:/不存在/Godot.exe" }, cwd: "C:/tmp" }),
    (e: unknown) => {
      const error = e as { code?: string; details?: Record<string, unknown> };
      assert.equal(error.code, "GODOT_NOT_FOUND");
      assert.equal(error.details?.["godotPath"], "C:/不存在/Godot.exe");
      return true;
    },
  );
});

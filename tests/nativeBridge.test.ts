import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameDecoder, encodeFrame, MAX_BRIDGE_MESSAGE_BYTES, makeRequest } from "../src/godot/bridge/protocol.js";

test("bridge frames survive TCP-style partial and coalesced reads", () => {
  const a = encodeFrame({ id: 1, text: "first" }); const b = encodeFrame({ id: 2, text: "second" });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(a.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(Buffer.concat([a.subarray(2), b])), [{ id: 1, text: "first" }, { id: 2, text: "second" }]);
});

// 帧头字节序由引擎决定:插件用 PackedByteArray.encode_u32/decode_u32,固定小端。
// Godot 4.6.3 实测 encode_u32(0, 65536) == [0,0,1,0],所以 4 字节头必须是 LE。
// 这里锁死线上字节,防止再改回 BE(那样插件会把长度读成天文数字并直接断开连接)。
test("bridge frame header is little-endian, matching Godot PackedByteArray.encode_u32", () => {
  const body = Buffer.from(JSON.stringify({ a: 1 }), "utf8");
  const frame = encodeFrame({ a: 1 });
  assert.equal(frame.length, body.length + 4);
  assert.deepEqual([...frame.subarray(0, 4)], [body.length & 0xff, 0, 0, 0]);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame), [{ a: 1 }]);
});

test("bridge protocol rejects oversized frames and creates authenticated requests", () => {
  assert.throws(() => encodeFrame("x".repeat(MAX_BRIDGE_MESSAGE_BYTES)), /maximum size/);
  const request = makeRequest("secret", "project_capabilities");
  assert.equal(request.protocolVersion, 1); assert.equal(request.token, "secret"); assert.equal(request.method, "project_capabilities"); assert.ok(request.requestId);
});

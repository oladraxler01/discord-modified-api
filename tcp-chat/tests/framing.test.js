// Unit tests for NDJSON framing: messages split across reads and combined in one read.
import test from "node:test";
import assert from "node:assert/strict";
import { encode, FrameDecoder } from "../protocol.js";

const messages = (results) => results.filter((r) => r.message).map((r) => r.message);

test("one complete frame in one read", () => {
  const d = new FrameDecoder();
  assert.deepEqual(messages(d.push(Buffer.from(encode({ type: "msg", text: "hi" })))), [
    { type: "msg", text: "hi" },
  ]);
});

test("one frame split across multiple reads", () => {
  const d = new FrameDecoder();
  const bytes = Buffer.from(encode({ type: "msg", text: "hello world" }));
  assert.deepEqual(d.push(bytes.subarray(0, 5)), []);
  assert.deepEqual(d.push(bytes.subarray(5, 12)), []);
  assert.deepEqual(messages(d.push(bytes.subarray(12))), [{ type: "msg", text: "hello world" }]);
});

test("frame delivered one byte at a time", () => {
  const d = new FrameDecoder();
  const bytes = Buffer.from(encode({ type: "msg", text: "byte by byte" }));
  const out = [];
  for (const b of bytes) out.push(...messages(d.push(Buffer.from([b]))));
  assert.deepEqual(out, [{ type: "msg", text: "byte by byte" }]);
});

test("several frames combined in a single read", () => {
  const d = new FrameDecoder();
  const chunk = Buffer.from(encode({ n: 1 }) + encode({ n: 2 }) + encode({ n: 3 }));
  assert.deepEqual(messages(d.push(chunk)), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("combined + split: 1.5 frames then the rest", () => {
  const d = new FrameDecoder();
  const all = Buffer.from(encode({ n: 1 }) + encode({ n: 2 }));
  const cut = encode({ n: 1 }).length + 3;
  assert.deepEqual(messages(d.push(all.subarray(0, cut))), [{ n: 1 }]);
  assert.deepEqual(messages(d.push(all.subarray(cut))), [{ n: 2 }]);
});

test("multi-byte UTF-8 character split across reads", () => {
  const d = new FrameDecoder();
  const bytes = Buffer.from(encode({ text: "héllo 👋" }));
  const emojiStart = bytes.indexOf(Buffer.from("👋"));
  assert.deepEqual(d.push(bytes.subarray(0, emojiStart + 2)), []);
  assert.deepEqual(messages(d.push(bytes.subarray(emojiStart + 2))), [{ text: "héllo 👋" }]);
});

test("malformed JSON is reported, and later frames still parse", () => {
  const d = new FrameDecoder();
  const results = d.push(Buffer.from('{not json}\n[1,2]\n{"ok":true}\n'));
  assert.equal(results[0].error, "Invalid JSON.");
  assert.equal(results[1].error, "Frame must be a JSON object.");
  assert.deepEqual(results[2].message, { ok: true });
});

test("CRLF line endings (telnet/netcat) are accepted", () => {
  const d = new FrameDecoder();
  assert.deepEqual(messages(d.push(Buffer.from('{"a":1}\r\n'))), [{ a: 1 }]);
});

test("oversized frame without newline is rejected as fatal", () => {
  const d = new FrameDecoder({ maxFrameBytes: 100 });
  const results = d.push(Buffer.from("x".repeat(200)));
  assert.equal(results[0].fatal, true);
});

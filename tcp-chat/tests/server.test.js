// Integration tests against a real TCP server on a random local port.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import os from "os";
import path from "path";

process.env.TCP_LOG_FILE = path.join(os.tmpdir(), `tcp-chat-test-${process.pid}.log`);
const { server } = await import("../server.js");
const { encode, FrameDecoder } = await import("../protocol.js");

let port;
before(() => new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  resolve();
})));
after(() => new Promise((resolve) => server.close(resolve)));

// Minimal test client that queues received frames and lets us await a matching one.
const connect = () => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const decoder = new FrameDecoder();
  const inbox = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    for (const { message } of decoder.push(chunk)) {
      if (!message) continue;
      const i = waiters.findIndex((w) => w.match(message));
      if (i !== -1) waiters.splice(i, 1)[0].resolve(message);
      else inbox.push(message);
    }
  });
  socket.on("error", () => {});
  const client = {
    socket,
    send: (m) => socket.write(encode(m)),
    raw: (s) => socket.write(s),
    next: (match, ms = 2000) => {
      const i = inbox.findIndex(match);
      if (i !== -1) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error("timeout waiting for frame")), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); res(m); } });
      });
    },
  };
  socket.once("connect", () => resolve(client));
  socket.once("error", reject);
});

const join = async (name) => {
  const c = await connect();
  c.send({ type: "hello", username: name });
  await c.next((m) => m.type === "welcome");
  return c;
};
const type = (t, extra = () => true) => (m) => m.type === t && extra(m);

test("three simultaneous clients exchange group messages", async () => {
  const a = await join("alice");
  const b = await join("bob");
  const c = await join("carol");
  a.send({ type: "msg", text: "hello all" });
  for (const client of [a, b, c]) {
    const m = await client.next(type("msg", (x) => x.text === "hello all"));
    assert.equal(m.from, "alice");
  }
  b.send({ type: "dm", to: "carol", text: "secret" });
  assert.equal((await c.next(type("dm"))).text, "secret");
  for (const x of [a, b, c]) x.socket.end();
});

test("client reconnects while others stay connected", async () => {
  const a = await join("dave");
  const b = await join("erin");
  b.send({ type: "bye" });
  assert.equal((await a.next(type("left", (m) => m.username === "erin"))).reason, "quit");
  const b2 = await join("erin"); // same name again after disconnect
  await a.next(type("joined", (m) => m.username === "erin"));
  b2.send({ type: "msg", text: "back again" });
  assert.equal((await a.next(type("msg", (m) => m.text === "back again"))).from, "erin");
  a.socket.end(); b2.socket.end();
});

test("abrupt termination (RST) is detected and cleaned up", async () => {
  const a = await join("frank");
  const b = await join("grace");
  b.socket.resetAndDestroy();
  const left = await a.next(type("left", (m) => m.username === "grace"));
  assert.equal(left.reason, "connection_reset");
  a.socket.end();
});

test("malformed input and invalid values do not crash the server", async () => {
  const a = await connect();
  a.raw("this is not json\n");
  assert.equal((await a.next(type("error"))).code, "malformed");
  a.send({ type: "msg", text: "too early" });
  assert.equal((await a.next(type("error"))).code, "not_identified");
  a.send({ type: "hello", username: "x" });
  assert.equal((await a.next(type("error"))).code, "invalid_username");
  a.send({ type: "hello", username: "heidi" });
  await a.next(type("welcome"));
  a.send({ type: "msg", text: "   " });
  assert.equal((await a.next(type("error"))).code, "invalid_text");
  a.send({ type: "nonsense" });
  assert.equal((await a.next(type("error"))).code, "unknown_type");
  const dup = await connect();
  dup.send({ type: "hello", username: "HEIDI" });
  assert.equal((await dup.next(type("error"))).code, "username_taken");
  // Server still works afterwards.
  a.send({ type: "msg", text: "still alive" });
  await a.next(type("msg", (m) => m.text === "still alive"));
  a.socket.end(); dup.socket.end();
});

test("frames split across TCP writes and combined in one write", async () => {
  const a = await join("ivan");
  const two = encode({ type: "msg", text: "one" }) + encode({ type: "msg", text: "two" });
  a.raw(two.slice(0, 7));
  await new Promise((r) => setTimeout(r, 50)); // force separate TCP segments
  a.raw(two.slice(7)); // rest of frame 1 + all of frame 2 in one write
  assert.equal((await a.next(type("msg"))).text, "one");
  assert.equal((await a.next(type("msg"))).text, "two");
  a.socket.end();
});

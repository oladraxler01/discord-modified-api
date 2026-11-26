// Experiment 4: latency (RTT) and throughput against the running chat server.
//
//   node tcp-chat/bench.js --host 127.0.0.1 --port 5000 --label baseline
//   node tcp-chat/bench.js --host <VM-IP> --port 5000 --label cloud --pings 50 --messages 500 --size 512
//
// Phase 1: --pings sequential ping/pong frames -> RTT min/avg/p95/max.
// Phase 2: --messages chat messages of --size characters sent back-to-back;
//          the server broadcasts each one back to us, so we time until the last
//          one returns -> messages/second and application throughput (KB/s).
import net from "net";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encode, FrameDecoder } from "./protocol.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const host = arg("host", "127.0.0.1");
const port = Number(arg("port", 5000));
const label = arg("label", "run");
const pings = Number(arg("pings", 50));
const messages = Number(arg("messages", 500));
const size = Math.min(Number(arg("size", 512)), 1000); // server limit is 1000 chars
// Seconds to pause after connecting, before measuring. Lets you switch on packet loss
// (clumsy / netem) AFTER the handshake, so the test measures data retransmission.
const pauseSec = Number(arg("pause", 0));
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = arg("out", path.join(here, "compare", "results"));

const socket = net.createConnection({ host, port });
socket.setNoDelay(true);
const decoder = new FrameDecoder();
let waiter = null;
const queue = [];
socket.on("data", (chunk) => {
  for (const { message } of decoder.push(chunk)) {
    if (!message) continue;
    if (waiter && waiter.match(message)) {
      const w = waiter;
      waiter = null;
      w.resolve(message);
    } else queue.push(message);
  }
});
const next = (match, ms = 60000) => {
  const i = queue.findIndex(match);
  if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    waiter = { match, resolve: (m) => { clearTimeout(t); resolve(m); } };
  });
};
const send = (m) => socket.write(encode(m));
const stats = (arr) => {
  const v = [...arr].sort((a, b) => a - b);
  const r = (x) => Number(x.toFixed(3));
  return {
    min: r(v[0]),
    avg: r(v.reduce((a, b) => a + b, 0) / v.length),
    p95: r(v[Math.min(v.length - 1, Math.floor(0.95 * v.length))]),
    max: r(v[v.length - 1]),
  };
};

socket.on("error", (e) => {
  console.error(`Connection error: ${e.code || e.message}`);
  process.exit(1);
});

socket.on("connect", async () => {
  const name = `bench${process.pid % 10000}`;
  send({ type: "hello", username: name });
  await next((m) => m.type === "welcome");
  console.log(`Connected ${socket.localAddress}:${socket.localPort} -> ${host}:${port} as ${name}`);
  for (let left = pauseSec; left > 0; left -= 1) {
    process.stdout.write(`Starting in ${left}s — switch on packet loss now...   \r`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (pauseSec) console.log("Measuring...                                        ");

  const rtts = [];
  for (let i = 0; i < pings; i += 1) {
    const t = process.hrtime.bigint();
    send({ type: "ping", t: String(i) });
    await next((m) => m.type === "pong" && m.t === String(i));
    rtts.push(Number(process.hrtime.bigint() - t) / 1e6);
  }

  // Drain any history/joined frames so they don't confuse phase 2.
  queue.length = 0;
  const body = "x".repeat(size - 8);
  const start = process.hrtime.bigint();
  for (let i = 1; i <= messages; i += 1) send({ type: "msg", text: `${String(i).padStart(7, "0")} ${body}` });
  let lastSeen = 0;
  while (lastSeen < messages) {
    const m = await next((x) => x.type === "msg" && x.from === name);
    lastSeen = Number(m.text.slice(0, 7));
  }
  const seconds = Number(process.hrtime.bigint() - start) / 1e9;
  const frameBytes = Buffer.byteLength(encode({ type: "msg", text: `0000001 ${body}` }));

  const summary = {
    label,
    target: `${host}:${port}`,
    rttMs: stats(rtts),
    pings,
    throughput: {
      messages,
      messageChars: size,
      frameBytesSent: frameBytes,
      seconds: Number(seconds.toFixed(3)),
      messagesPerSecond: Number((messages / seconds).toFixed(1)),
      sendKBps: Number(((messages * frameBytes) / 1024 / seconds).toFixed(1)),
    },
    finishedAt: new Date().toISOString(),
  };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${label}-bench.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Saved ${file}`);
  send({ type: "bye" });
});
socket.on("close", () => process.exit(0));

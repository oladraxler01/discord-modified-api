// TCP vs UDP comparison: SENDER.
//
//   node tcp-chat/compare/sender.js --proto udp --host 127.0.0.1 --port 6001 --count 100 --interval 20 --label baseline
//   node tcp-chat/compare/sender.js --proto tcp --host 127.0.0.1 --port 6002 --count 100 --interval 20 --label baseline
//
// Sends --count numbered messages, one every --interval ms. The receiver echoes
// each one back, so the sender measures round-trip time (RTT) with its own clock
// (works across machines). A UDP echo can itself be lost, so "echoes received"
// reflects loss in BOTH directions; use the receiver's count for one-way delivery.
import dgram from "dgram";
import net from "net";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encode, FrameDecoder } from "../protocol.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const proto = arg("proto", "udp");
const host = arg("host", "127.0.0.1");
const port = Number(arg("port", proto === "udp" ? 6001 : 6002));
const count = Number(arg("count", 100));
const interval = Number(arg("interval", 20));
const label = arg("label", "run");
const waitMs = Number(arg("wait", 3000)); // how long to wait for late echoes
const pauseSec = Number(arg("pause", 0)); // pause before sending (switch on loss after TCP handshake)
const countdown = async () => {
  for (let left = pauseSec; left > 0; left -= 1) {
    process.stdout.write(`Starting in ${left}s — switch on packet loss now...   \r`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = arg("out", path.join(here, "results"));

const rtts = new Map(); // seq -> RTT ms
const nowHr = () => process.hrtime.bigint();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onEcho = (m) => {
  if (m.type !== "echo" || rtts.has(m.seq)) return;
  rtts.set(m.seq, Number(nowHr() - BigInt(m.hr)) / 1e6);
};

const report = (sendDurationMs) => {
  const values = [...rtts.values()].sort((a, b) => a - b);
  const pct = (p) => values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))];
  const r3 = (x) => (x === undefined ? null : Number(x.toFixed(3)));
  const summary = {
    protocol: proto.toUpperCase(),
    label,
    target: `${host}:${port}`,
    sent: count,
    intervalMs: interval,
    echoesReceived: rtts.size,
    echoLossPercent: Number((((count - rtts.size) / count) * 100).toFixed(2)),
    rttMs: values.length
      ? {
          min: r3(values[0]),
          avg: r3(values.reduce((a, b) => a + b, 0) / values.length),
          p95: r3(pct(95)),
          max: r3(values[values.length - 1]),
        }
      : null,
    sendDurationMs: Math.round(sendDurationMs),
    finishedAt: new Date().toISOString(),
  };
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${label}-${proto}-sender`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    `${base}.csv`,
    "seq,rttMs\n" +
      Array.from({ length: count }, (_, i) => `${i + 1},${rtts.has(i + 1) ? r3(rtts.get(i + 1)) : "LOST"}`).join("\n") +
      "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Saved ${base}.json and .csv`);
};

const data = (seq) => ({ type: "data", seq, sentAt: Date.now(), hr: nowHr().toString() });

if (proto === "udp") {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (buf) => {
    try {
      onEcho(JSON.parse(buf.toString()));
    } catch { /* ignore */ }
  });
  socket.bind(0, async () => {
    await countdown();
    console.log(`UDP sending ${count} datagrams to ${host}:${port} from local port ${socket.address().port}`);
    const start = Date.now();
    for (let seq = 1; seq <= count; seq += 1) {
      socket.send(JSON.stringify(data(seq)), port, host); // fire and forget: no ACK, no retransmit
      await sleep(interval);
    }
    const sendDuration = Date.now() - start;
    // The end marker can be lost too, so send it several times; receiver also has an idle timeout.
    for (let i = 0; i < 5; i += 1) socket.send(JSON.stringify({ type: "end", count }), port, host);
    await sleep(waitMs);
    report(sendDuration);
    socket.close();
  });
} else {
  const socket = net.createConnection({ host, port });
  socket.setNoDelay(true);
  const decoder = new FrameDecoder();
  socket.on("data", (chunk) => {
    for (const { message } of decoder.push(chunk)) if (message) onEcho(message);
  });
  socket.on("error", (e) => {
    console.error(`TCP error: ${e.code || e.message}`);
    process.exitCode = 1;
  });
  socket.on("connect", async () => {
    console.log(`TCP connected ${socket.localAddress}:${socket.localPort} -> ${host}:${port}, sending ${count} messages`);
    await countdown();
    const start = Date.now();
    for (let seq = 1; seq <= count; seq += 1) {
      socket.write(encode(data(seq)));
      await sleep(interval);
    }
    const sendDuration = Date.now() - start;
    socket.write(encode({ type: "end", count }));
    const deadline = Date.now() + Math.max(waitMs, 30000); // TCP retransmits, so wait longer
    while (rtts.size < count && Date.now() < deadline) await sleep(50);
    report(sendDuration);
    socket.end();
  });
}

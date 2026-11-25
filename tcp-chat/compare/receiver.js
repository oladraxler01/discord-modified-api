// TCP vs UDP comparison: RECEIVER.  (Separate from the chat app, used only for the experiment.)
//
//   node tcp-chat/compare/receiver.js --proto udp --port 6001 --label baseline
//   node tcp-chat/compare/receiver.js --proto tcp --port 6002 --label baseline
//
// Records every numbered message it receives and echoes it back so the
// sender can measure round-trip time. When the sender's "end" marker arrives
// (or after --idle ms of silence) it prints and saves a summary:
//   received count, missing sequence numbers, duplicates, out-of-order arrivals,
//   one-way latency (only meaningful if sender and receiver share a clock, i.e. same machine).
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
const port = Number(arg("port", proto === "udp" ? 6001 : 6002));
const label = arg("label", "run");
const idleMs = Number(arg("idle", 5000));
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = arg("out", path.join(here, "results"));

let records = [];
let expected = null;
let idleTimer = null;
let runStart = null;

const finish = () => {
  clearTimeout(idleTimer);
  if (!records.length) return;
  const seqs = records.map((r) => r.seq);
  const total = expected ?? Math.max(...seqs);
  const seen = new Set();
  let duplicates = 0;
  let outOfOrder = 0;
  let highest = 0;
  for (const s of seqs) {
    if (seen.has(s)) duplicates += 1;
    seen.add(s);
    if (s < highest) outOfOrder += 1;
    highest = Math.max(highest, s);
  }
  const missing = [];
  for (let s = 1; s <= total; s += 1) if (!seen.has(s)) missing.push(s);
  const lat = records.map((r) => r.oneWayMs).sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
  const summary = {
    protocol: proto.toUpperCase(),
    label,
    expected: total,
    received: records.length,
    unique: seen.size,
    lossPercent: Number((((total - seen.size) / total) * 100).toFixed(2)),
    missing,
    duplicates,
    outOfOrder,
    inOrder: outOfOrder === 0,
    oneWayLatencyMs: {
      min: lat[0],
      avg: Number((lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(3)),
      p95: pct(95),
      max: lat[lat.length - 1],
      note: "Valid only when sender and receiver run on the same machine (shared clock).",
    },
    durationMs: Date.now() - runStart,
    finishedAt: new Date().toISOString(),
  };
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${label}-${proto}-receiver`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    `${base}.csv`,
    "arrivalIndex,seq,oneWayMs\n" + records.map((r, i) => `${i + 1},${r.seq},${r.oneWayMs}`).join("\n") + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Saved ${base}.json and .csv — waiting for the next run (Ctrl+C to stop).`);
  records = [];
  expected = null;
  runStart = null;
};

const onPacket = (msg, reply) => {
  if (msg.type === "end") {
    expected = msg.count;
    finish();
    return;
  }
  if (msg.type !== "data") return;
  if (!runStart) runStart = Date.now();
  records.push({ seq: msg.seq, oneWayMs: Number((Date.now() - msg.sentAt).toFixed(3)) });
  reply({ type: "echo", seq: msg.seq, sentAt: msg.sentAt, hr: msg.hr });
  clearTimeout(idleTimer);
  idleTimer = setTimeout(finish, idleMs);
};

if (proto === "udp") {
  // UDP: no connection, no handshake. Each datagram is one message (boundaries preserved).
  const socket = dgram.createSocket("udp4");
  socket.on("message", (buf, rinfo) => {
    try {
      onPacket(JSON.parse(buf.toString()), (m) =>
        socket.send(JSON.stringify(m), rinfo.port, rinfo.address),
      );
    } catch {
      console.error(`Ignored malformed datagram from ${rinfo.address}:${rinfo.port}`);
    }
  });
  socket.bind(port, "0.0.0.0", () => console.log(`UDP receiver on 0.0.0.0:${port} (label=${label})`));
} else {
  // TCP: byte stream, so we reuse the chat's newline framing.
  net
    .createServer((socket) => {
      socket.setNoDelay(true);
      console.log(`TCP sender connected from ${socket.remoteAddress}:${socket.remotePort}`);
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const { message } of decoder.push(chunk)) {
          if (message) onPacket(message, (m) => socket.write(encode(m)));
        }
      });
      socket.on("error", (e) => console.error(`TCP error: ${e.code}`));
      socket.on("close", () => finish());
    })
    .listen(port, "0.0.0.0", () => console.log(`TCP receiver on 0.0.0.0:${port} (label=${label})`));
}

// Build a Markdown comparison table from tcp-chat/compare/results/*.json
//   node tcp-chat/compare/summarize.js  ->  prints table and writes results/RESULTS.md
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

const runs = {};
for (const f of files) {
  const m = /^(.*)-(udp|tcp)-(sender|receiver)\.json$/.exec(f);
  if (!m) continue;
  const [, label, proto, role] = m;
  runs[`${label}|${proto}`] ??= { label, proto: proto.toUpperCase() };
  runs[`${label}|${proto}`][role] = load(f);
}

const rows = Object.values(runs).sort((a, b) => a.label.localeCompare(b.label) || a.proto.localeCompare(b.proto));
const fmt = (x) => (x === undefined || x === null ? "–" : x);
let md = "# TCP vs UDP comparison results\n\n";
md += "| Condition | Protocol | Sent | Received (unique) | Loss % | Missing seqs | Duplicates | Out of order | RTT avg ms | RTT p95 ms | RTT max ms |\n";
md += "|---|---|---|---|---|---|---|---|---|---|---|\n";
for (const r of rows) {
  const rc = r.receiver || {};
  const s = r.sender || {};
  const missing = rc.missing ? (rc.missing.length > 12 ? `${rc.missing.slice(0, 12).join(", ")}, … (${rc.missing.length})` : rc.missing.join(", ") || "none") : "–";
  md += `| ${r.label} | ${r.proto} | ${fmt(s.sent ?? rc.expected)} | ${fmt(rc.unique)} | ${fmt(rc.lossPercent)} | ${missing} | ${fmt(rc.duplicates)} | ${fmt(rc.outOfOrder)} | ${fmt(s.rttMs?.avg)} | ${fmt(s.rttMs?.p95)} | ${fmt(s.rttMs?.max)} |\n`;
}
md += "\nRTT is measured by the sender from echoes. For UDP, an echo can also be lost, so the sender's echo count reflects loss in both directions. The receiver columns show one-way delivery.\n";

const bench = files.filter((f) => f.endsWith("-bench.json")).map(load);
if (bench.length) {
  md += "\n## Experiment 4: chat server latency and throughput\n\n";
  md += "| Condition | RTT avg ms | RTT p95 ms | RTT max ms | Messages | Seconds | Msg/s | KB/s sent |\n|---|---|---|---|---|---|---|---|\n";
  for (const b of bench) {
    md += `| ${b.label} | ${b.rttMs.avg} | ${b.rttMs.p95} | ${b.rttMs.max} | ${b.throughput.messages} | ${b.throughput.seconds} | ${b.throughput.messagesPerSecond} | ${b.throughput.sendKBps} |\n`;
  }
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "RESULTS.md"), md);
console.log(md);

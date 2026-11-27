// Live voice call over raw UDP (one process per person).
//
//   Same laptop, two people:
//     node tcp-chat/udp-call.js --name ola   --port 7001 --peer 127.0.0.1:7002 --web 8081
//     node tcp-chat/udp-call.js --name james --port 7002 --peer 127.0.0.1:7001 --web 8082
//   then open http://localhost:8081 and http://localhost:8082 and press "Start call" in both.
//
//   Two laptops on the same Wi-Fi: use the other laptop's IP in --peer (e.g. 192.168.1.20:7002).
//
// Browser mic -> 16 kHz PCM, 20 ms frames -> WebSocket -> this process -> ONE UDP datagram per frame
//   datagram = "VC" | seq (uint32) | timestamp (uint32) | sentAt ms (float64) | 640 bytes PCM
// Received datagrams -> statistics (lost / out of order / duplicates / jitter) -> browser speaker.
// No handshake, no ACK, no retransmission: a lost packet is simply a 20 ms gap in the audio.
import dgram from "dgram";
import http from "http";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const name = arg("name", "user");
const udpPort = Number(arg("port", 7001));
const [peerHost, peerPortStr] = arg("peer", "127.0.0.1:7002").split(":");
const peerPort = Number(peerPortStr);
const webPort = Number(arg("web", 8081));
const HEADER = 18;

const udp = dgram.createSocket("udp4");
let seq = 0;
const tx = { packets: 0, bytes: 0 };
let rx;
const resetRx = () => { rx = { packets: 0, bytes: 0, firstSeq: null, maxSeq: -1, seen: new Set(), outOfOrder: 0, duplicates: 0, jitter: 0, lastTransit: null, from: null, lastAt: 0 }; };
resetRx();

udp.on("message", (buf, rinfo) => {
  if (buf.length < HEADER || buf[0] !== 0x56 || buf[1] !== 0x43) return; // "VC"
  const s = buf.readUInt32BE(2);
  const sentAt = buf.readDoubleBE(10);
  const now = Date.now();
  if (rx.firstSeq === null || s < rx.firstSeq - 1000) { resetRx(); rx.firstSeq = s; }
  rx.packets += 1; rx.bytes += buf.length; rx.from = `${rinfo.address}:${rinfo.port}`; rx.lastAt = now;
  if (rx.seen.has(s)) rx.duplicates += 1; else rx.seen.add(s);
  if (s < rx.maxSeq) rx.outOfOrder += 1; else rx.maxSeq = s;
  // RFC 3550-style interarrival jitter (sender clock offset cancels out in the difference).
  const transit = now - sentAt;
  if (rx.lastTransit !== null) rx.jitter += (Math.abs(transit - rx.lastTransit) - rx.jitter) / 16;
  rx.lastTransit = transit;
  const pcm = buf.subarray(HEADER);
  for (const c of wss.clients) if (c.readyState === 1) c.send(pcm);
});
udp.bind(udpPort, "0.0.0.0", () => console.log(`[${name}] UDP voice socket on 0.0.0.0:${udpPort} -> peer ${peerHost}:${peerPort}`));

const sendFrame = (pcm) => {
  const buf = Buffer.alloc(HEADER + pcm.length);
  buf.write("VC", 0, "ascii");
  buf.writeUInt32BE(seq >>> 0, 2);
  buf.writeUInt32BE((seq * 320) >>> 0, 6);
  buf.writeDoubleBE(Date.now(), 10);
  pcm.copy(buf, HEADER);
  seq += 1;
  udp.send(buf, peerPort, peerHost); // fire and forget
  tx.packets += 1; tx.bytes += buf.length;
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => { if (isBinary && data.length === 640) sendFrame(Buffer.from(data)); });
});
setInterval(() => {
  const expected = rx.firstSeq === null ? 0 : rx.maxSeq - rx.firstSeq + 1;
  const lost = Math.max(0, expected - rx.seen.size);
  const stats = {
    name, local: `0.0.0.0:${udpPort}`, peer: `${peerHost}:${peerPort}`, from: rx.from,
    sent: tx.packets, sentKB: Math.round(tx.bytes / 1024), received: rx.packets, expected, lost,
    lossPct: expected ? ((lost / expected) * 100).toFixed(1) : "0.0",
    outOfOrder: rx.outOfOrder, duplicates: rx.duplicates, jitter: rx.jitter.toFixed(1),
    receiving: Date.now() - rx.lastAt < 1000,
  };
  for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify(stats));
}, 500);
server.listen(webPort, () => console.log(`[${name}] open http://localhost:${webPort}`));

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UDP voice call</title><style>
body{margin:0;font-family:system-ui,Segoe UI,sans-serif;background:#0b1020;color:#e5e7eb;display:flex;justify-content:center;padding:24px}
.card{width:100%;max-width:720px;background:#141b2d;border:1px solid #1e293b;border-radius:18px;padding:22px}
h1{margin:0 0 4px;font-size:22px}.sub{color:#94a3b8;font-size:13px;margin-bottom:16px;font-family:ui-monospace,Consolas,monospace}
button{font:inherit;border:0;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;margin-right:8px}
#start{background:#16a34a;color:#fff}#stop{background:#dc2626;color:#fff;display:none}.gray{background:#334155;color:#fff}
#state{margin:14px 0;font-size:15px}.live{color:#4ade80}.idle{color:#94a3b8}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.s{background:#0b1220;border:1px solid #1e293b;border-radius:10px;padding:8px 10px}.s span{display:block;font-size:11px;color:#94a3b8;text-transform:uppercase}
.s b{font-size:18px;font-family:ui-monospace,Consolas,monospace}.bad b{color:#f87171}
.note{margin-top:14px;font-size:12px;color:#94a3b8;line-height:1.5}</style></head><body><div class="card">
<h1>🎙️ UDP voice call — <span id="nm"></span></h1><div class="sub" id="sub"></div>
<button id="start">Start call</button><button id="stop">Stop</button><button class="gray" id="mute">Mute mic</button><button class="gray" id="spk">Mute speaker</button>
<div id="state" class="idle">Not started</div><div class="grid" id="g"></div>
<div class="note">Each 20 ms of audio = 1 UDP datagram (658 bytes: 18-byte header with sequence number + 640 bytes PCM), ~50 packets/s each way.
No handshake, no ACKs, no retransmission — lost packets are just gaps. Wireshark: <b>udp.port == 7001 || udp.port == 7002</b>. Use earphones on one laptop to avoid echo.</div></div>
<script>
const ws=new WebSocket("ws://"+location.host);ws.binaryType="arraybuffer";
let ctx,proc,src,stream,gain,muted=false,spkMuted=false,playAt=0,running=false,q=new Int16Array(0);
const g=document.getElementById("g");
ws.onmessage=(e)=>{
 if(typeof e.data==="string"){const s=JSON.parse(e.data);document.getElementById("nm").textContent=s.name;
  document.getElementById("sub").textContent="UDP "+s.local+"  →  peer "+s.peer+(s.from?"   (receiving from "+s.from+")":"");
  if(running){const st=document.getElementById("state");st.textContent=s.receiving?"● Live — voice flowing over UDP":"● Sending… waiting for the other side";st.className="live";}
  const cells=[["Packets sent",s.sent],["Data sent",s.sentKB+" KB"],["Packets received",s.received],["Expected",s.expected],["Lost",s.lost,s.lost>0],["Loss",s.lossPct+" %",Number(s.lossPct)>1],["Out of order",s.outOfOrder,s.outOfOrder>0],["Duplicates",s.duplicates],["Jitter",s.jitter+" ms"]];
  g.innerHTML="";cells.forEach(([k,v,b])=>{const d=document.createElement("div");d.className="s"+(b?" bad":"");d.innerHTML="<span></span><b></b>";d.children[0].textContent=k;d.children[1].textContent=v;g.append(d);});return;}
 if(!ctx||spkMuted)return;const i16=new Int16Array(e.data),f=new Float32Array(i16.length);for(let i=0;i<i16.length;i++)f[i]=i16[i]/32768;
 const b=ctx.createBuffer(1,f.length,16000);b.copyToChannel(f,0);const n=ctx.createBufferSource();n.buffer=b;n.connect(ctx.destination);
 const now=ctx.currentTime;if(playAt<now+0.04||playAt>now+0.4)playAt=now+0.08;n.start(playAt);playAt+=f.length/16000;};
document.getElementById("start").onclick=async()=>{
 stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
 ctx=new AudioContext({sampleRate:16000});src=ctx.createMediaStreamSource(stream);proc=ctx.createScriptProcessor(1024,1,1);gain=ctx.createGain();gain.gain.value=0;
 src.connect(proc);proc.connect(gain);gain.connect(ctx.destination);
 proc.onaudioprocess=(e)=>{const inp=e.inputBuffer.getChannelData(0),add=new Int16Array(inp.length);
  for(let i=0;i<inp.length;i++)add[i]=muted?0:Math.max(-32768,Math.min(32767,inp[i]*32767));
  const m=new Int16Array(q.length+add.length);m.set(q);m.set(add,q.length);q=m;
  while(q.length>=320){ws.readyState===1&&ws.send(q.slice(0,320).buffer);q=q.slice(320);}};
 running=true;document.getElementById("start").style.display="none";document.getElementById("stop").style.display="";};
document.getElementById("stop").onclick=()=>{running=false;proc&&proc.disconnect();stream&&stream.getTracks().forEach(t=>t.stop());ctx&&ctx.close();ctx=null;
 document.getElementById("start").style.display="";document.getElementById("stop").style.display="none";const st=document.getElementById("state");st.textContent="Stopped";st.className="idle";};
document.getElementById("mute").onclick=(e)=>{muted=!muted;e.target.textContent=muted?"Unmute mic":"Mute mic";};
document.getElementById("spk").onclick=(e)=>{spkMuted=!spkMuted;e.target.textContent=spkMuted?"Unmute speaker":"Mute speaker";};
</script></body></html>`;

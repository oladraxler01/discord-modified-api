// WebSocket gateway for hosting the TCP chat on Render (or any HTTP-only PaaS).
//
// Render only exposes ONE public HTTP(S) port per service, so raw TCP port 5000 can't be
// reached from the Internet. This process:
//   1. starts the real TCP chat server (server.js) on 127.0.0.1:5000 (internal only);
//   2. serves the web chat page and a WebSocket endpoint (/ws) on $PORT;
//   3. for EVERY WebSocket client, opens its own raw TCP socket to the chat server and
//      relays JSON messages both ways (WebSocket message <-> NDJSON frame on TCP).
//
// Path of one message:
//   browser --WSS (TLS over TCP 443)--> Render proxy --WS over TCP--> gateway
//          --raw TCP (NDJSON)--> chat server :5000
//
//   PORT=8080 node tcp-chat/gateway.js      then open http://localhost:8080
import http from "http";
import net from "net";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { server as chatServer, log } from "./server.js";
import { encode, FrameDecoder } from "./protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.PORT || 8080);
const TCP_PORT = Number(process.env.TCP_PORT || 5000);
const page = fs.readFileSync(path.join(here, "web", "index.html"));

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (req.url === "/ice") {
    // ICE servers for the browser's WebRTC voice call. STUN finds the public address;
    // optional TURN (set TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL in Render) relays UDP
    // when the two devices cannot reach each other directly (mobile data, hotspots, strict NAT).
    const iceServers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
    if (process.env.TURN_URLS) {
      iceServers.push({
        urls: process.env.TURN_URLS.split(",").map((u) => u.trim()).filter(Boolean),
        username: process.env.TURN_USERNAME || "",
        credential: process.env.TURN_CREDENTIAL || "",
      });
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ iceServers }));
  }
  if (req.url === "/" || req.url.startsWith("/?")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page);
  }
  res.writeHead(404);
  return res.end("not found");
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: 512 * 1024 });
let nextGatewayId = 1;

wss.on("connection", (ws, req) => {
  const id = nextGatewayId++;
  const publicIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  // One dedicated TCP connection per WebSocket user: the chat server sees each user as a socket.
  const tcp = net.createConnection({ host: "127.0.0.1", port: TCP_PORT });
  tcp.setNoDelay(true);
  const decoder = new FrameDecoder();
  ws.isAlive = true;

  tcp.on("connect", () => {
    log("INFO", "gateway_open", {
      gw: id,
      publicClient: publicIp,
      tcpLocal: `${tcp.localAddress}:${tcp.localPort}`,
      tcpRemote: `${tcp.remoteAddress}:${tcp.remotePort}`,
    });
    ws.send(JSON.stringify({ type: "gateway", publicClient: publicIp, tcpLocalPort: tcp.localPort, tcpServerPort: TCP_PORT }));
  });

  // TCP -> WebSocket: re-frame the byte stream into whole messages first.
  tcp.on("data", (chunk) => {
    for (const { message } of decoder.push(chunk)) {
      if (message && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    }
  });

  // WebSocket -> TCP: each WebSocket message becomes exactly one NDJSON frame.
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      // Pass malformed input through (newlines stripped) so the TCP server validates and replies.
      tcp.write(String(data).replace(/[\r\n]/g, " ") + "\n");
      return;
    }
    tcp.write(encode(msg));
  });

  ws.on("pong", () => { ws.isAlive = true; });

  // Browser closed cleanly -> graceful TCP close (FIN). Abnormal close (1006) -> RST.
  ws.on("close", (code) => {
    log("INFO", "gateway_ws_closed", { gw: id, code });
    if (code === 1006) tcp.resetAndDestroy();
    else tcp.end();
  });
  ws.on("error", () => tcp.resetAndDestroy());

  tcp.on("end", () => ws.close(1000, "server closed"));
  tcp.on("error", (e) => {
    log("WARN", "gateway_tcp_error", { gw: id, code: e.code });
    ws.close(1011, "tcp error");
  });
});

// Render's proxy drops idle WebSockets; ping every 25 s and drop dead browsers.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000).unref();

chatServer.listen(TCP_PORT, "127.0.0.1", () => {
  log("INFO", "listening", { host: "127.0.0.1", port: TCP_PORT, role: "tcp-chat (internal)" });
  httpServer.listen(HTTP_PORT, "0.0.0.0", () => {
    log("INFO", "gateway_listening", { port: HTTP_PORT, ws: "/ws" });
  });
});

const shutdown = (signal) => {
  log("INFO", "shutdown", { signal });
  for (const ws of wss.clients) ws.close(1001, "server shutting down");
  httpServer.close();
  chatServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

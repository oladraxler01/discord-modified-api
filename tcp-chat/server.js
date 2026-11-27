// Multi-user TCP chat server (Node.js `net` module = raw TCP sockets).
//
//   node tcp-chat/server.js            # listens on 0.0.0.0:5000
//   TCP_PORT=6000 node tcp-chat/server.js
//
// Each client is one TCP connection, identified by the 4-tuple
// (client IP, client port, server IP, server port). The OS kernel does the
// three-way handshake (SYN, SYN-ACK, ACK) before the 'connection' event fires.
import net from "net";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  encode,
  FrameDecoder,
  validateText,
  validateUsername,
  validateVoice,
} from "./protocol.js";

const HOST = process.env.TCP_HOST || "0.0.0.0";
const PORT = Number(process.env.TCP_PORT || 5000);
const IDLE_TIMEOUT_MS = Number(process.env.TCP_IDLE_TIMEOUT_MS || 5 * 60 * 1000);
const MAX_ERRORS = 10; // malformed frames tolerated before we drop a client
const HISTORY_SIZE = 20;

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = process.env.TCP_LOG_FILE || path.join(here, "logs", "server.log");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

export const log = (level, event, details = {}) => {
  const line = `${new Date().toISOString()} [${level}] ${event} ${JSON.stringify(details)}`;
  (level === "ERROR" ? console.error : console.log)(line);
  logStream.write(line + "\n");
};

const clients = new Map(); // connectionId -> client state
const history = [];
let nextConnectionId = 1;
let nextSeq = 1;

const activeUsers = () =>
  [...clients.values()].filter((c) => c.username).map((c) => c.username);

const findByName = (name) =>
  [...clients.values()].find(
    (c) => c.username && c.username.toLowerCase() === String(name).toLowerCase(),
  );

const send = (client, message) => {
  if (!client.socket.destroyed && client.socket.writable) {
    client.socket.write(encode(message));
  }
};

const broadcast = (message, except = null) => {
  for (const client of clients.values()) {
    if (client.username && client !== except) send(client, message);
  }
};

const sendError = (client, code, message) => {
  client.errors += 1;
  log("WARN", "client_error", { id: client.id, peer: client.peer, code, message });
  send(client, { type: "error", code, message });
  if (client.errors >= MAX_ERRORS) {
    send(client, { type: "error", code: "too_many_errors", message: "Disconnecting." });
    client.socket.end(); // graceful close: sends FIN
  }
};

const handleMessage = (client, msg) => {
  // Before identification, only "hello" (and ping) is allowed.
  if (!client.username && msg.type !== "hello" && msg.type !== "ping") {
    return sendError(client, "not_identified", 'Send {"type":"hello","username":"..."} first.');
  }

  switch (msg.type) {
    case "hello": {
      if (client.username) return sendError(client, "already_identified", "Already identified.");
      const invalid = validateUsername(msg.username);
      if (invalid) return sendError(client, "invalid_username", invalid);
      if (findByName(msg.username)) {
        return sendError(client, "username_taken", "That username is already connected.");
      }
      client.username = msg.username;
      log("INFO", "user_joined", { id: client.id, peer: client.peer, username: client.username });
      send(client, {
        type: "welcome",
        username: client.username,
        connectionId: client.id,
        client: { ip: client.socket.remoteAddress, port: client.socket.remotePort },
        server: { ip: client.socket.localAddress, port: client.socket.localPort },
        users: activeUsers(),
        history,
      });
      broadcast({ type: "joined", username: client.username, ts: Date.now() }, client);
      return undefined;
    }

    case "msg": {
      const invalid = validateText(msg.text);
      if (invalid) return sendError(client, "invalid_text", invalid);
      const out = {
        type: "msg",
        seq: nextSeq++,
        from: client.username,
        text: msg.text.trim(),
        ts: Date.now(),
      };
      history.push(out);
      if (history.length > HISTORY_SIZE) history.shift();
      broadcast(out); // includes sender, as delivery confirmation
      return undefined;
    }

    case "voice": {
      const invalid = validateVoice(msg);
      if (invalid) return sendError(client, "invalid_voice", invalid);
      const out = {
        type: "voice",
        seq: nextSeq++,
        from: client.username,
        data: msg.data,
        duration: Math.round(Number(msg.duration) * 10) / 10,
        ts: Date.now(),
      };
      log("INFO", "voice_note", { from: client.username, seq: out.seq, bytes: msg.data.length, duration: out.duration });
      broadcast(out); // not kept in history: keeps the welcome frame small
      return undefined;
    }

    case "call": {
      // Voice-call SIGNALLING over TCP (offer / answer / ICE candidate / hangup).
      // The voice itself never passes through this server: it flows peer-to-peer over UDP (WebRTC/RTP).
      const target = findByName(msg.to);
      if (!target || target === client) return sendError(client, "unknown_user", `User "${msg.to}" is not connected.`);
      if (!msg.signal || typeof msg.signal !== "object" || Array.isArray(msg.signal)) {
        return sendError(client, "invalid_call", "Call signal must be an object.");
      }
      if (JSON.stringify(msg.signal).length > 64 * 1024) return sendError(client, "invalid_call", "Call signal too large.");
      if (msg.signal.kind !== "candidate" && msg.signal.kind !== "audio") {
        log("INFO", "call_signal", { from: client.username, to: target.username, kind: String(msg.signal.kind) });
      }
      send(target, { type: "call", from: client.username, signal: msg.signal });
      return undefined;
    }

    case "typing":
      // Short-lived hint ("ola is typing…"); a lost one would not matter (a UDP-style use case).
      for (const other of clients.values()) {
        if (other.username && other !== client) send(other, { type: "typing", from: client.username });
      }
      return undefined;

    case "dm": {
      const invalid = validateText(msg.text);
      if (invalid) return sendError(client, "invalid_text", invalid);
      const target = findByName(msg.to);
      if (!target) return sendError(client, "unknown_user", `User "${msg.to}" is not connected.`);
      const out = { type: "dm", from: client.username, to: target.username, text: msg.text.trim(), ts: Date.now() };
      send(target, out);
      if (target !== client) send(client, out);
      return undefined;
    }

    case "list":
      return send(client, { type: "users", users: activeUsers() });

    case "ping":
      // Echo the client's timestamp so it can compute round-trip time (RTT).
      return send(client, { type: "pong", t: msg.t, serverTs: Date.now() });

    case "bye":
      log("INFO", "client_quit", { id: client.id, username: client.username });
      client.leaveReason = "quit";
      send(client, { type: "bye" });
      client.socket.end(); // half-close: our FIN goes out after pending data
      return undefined;

    default:
      return sendError(client, "unknown_type", `Unknown message type "${msg.type}".`);
  }
};

export const server = net.createServer((socket) => {
  const client = {
    id: nextConnectionId++,
    socket,
    peer: `${socket.remoteAddress}:${socket.remotePort}`,
    username: null,
    decoder: new FrameDecoder(),
    errors: 0,
    leaveReason: null,
  };
  clients.set(client.id, client);
  log("INFO", "connection_open", {
    id: client.id,
    peer: client.peer,
    local: `${socket.localAddress}:${socket.localPort}`,
    total: clients.size,
  });

  socket.setNoDelay(true); // disable Nagle: send small chat frames immediately
  socket.setKeepAlive(true, 30_000); // OS probes detect silently dead peers
  socket.setTimeout(IDLE_TIMEOUT_MS);

  socket.on("data", (chunk) => {
    for (const result of client.decoder.push(chunk)) {
      if (result.error) {
        sendError(client, "malformed", result.error);
        if (result.fatal) socket.end();
        continue;
      }
      try {
        handleMessage(client, result.message);
      } catch (error) {
        // A bug in one handler must never crash the whole server.
        log("ERROR", "handler_failed", { id: client.id, error: error.message });
        sendError(client, "server_error", "Could not process message.");
      }
    }
  });

  socket.on("timeout", () => {
    log("WARN", "idle_timeout", { id: client.id, username: client.username });
    client.leaveReason = "timeout";
    send(client, { type: "error", code: "idle_timeout", message: "Idle too long." });
    socket.end();
  });

  // 'end' = the peer sent FIN (normal, orderly disconnect).
  socket.on("end", () => {
    log("INFO", "peer_fin_received", { id: client.id, username: client.username });
    if (!client.leaveReason) client.leaveReason = "closed";
    socket.end();
  });

  // 'error' = e.g. ECONNRESET when the peer sent RST (crash / killed process).
  socket.on("error", (error) => {
    log("WARN", "socket_error", { id: client.id, username: client.username, code: error.code });
    client.leaveReason = error.code === "ECONNRESET" ? "connection_reset" : `error:${error.code}`;
  });

  // 'close' always fires last: the single place where we clean up state.
  socket.on("close", (hadError) => {
    clients.delete(client.id);
    log("INFO", "connection_closed", {
      id: client.id,
      peer: client.peer,
      username: client.username,
      reason: client.leaveReason || (hadError ? "error" : "closed"),
      total: clients.size,
    });
    if (client.username) {
      broadcast({ type: "left", username: client.username, reason: client.leaveReason || "closed", ts: Date.now() });
    }
  });
});

server.on("error", (error) => {
  log("ERROR", "server_error", { code: error.code, message: error.message });
  if (error.code === "EADDRINUSE") process.exit(1);
});

const shutdown = (signal) => {
  log("INFO", "shutdown", { signal, clients: clients.size });
  broadcast({ type: "error", code: "server_shutdown", message: "Server is shutting down." });
  server.close(() => process.exit(0));
  for (const client of clients.values()) client.socket.end();
  setTimeout(() => {
    for (const client of clients.values()) client.socket.destroy();
    process.exit(0);
  }, 3000).unref();
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  server.listen(PORT, HOST, () => {
    log("INFO", "listening", { host: HOST, port: PORT, pid: process.pid });
  });
}

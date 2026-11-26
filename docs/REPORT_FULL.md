---
title: "Design, Implementation and Cloud Deployment of a Multi-User TCP Chat Application"
subtitle: "Data Communication and Networking — Practical Programming Assignment (400 Level)"
author: "Ogunkuade Olasunkanmi — VUG/CSC/24/12403"
date: "Department of Computer Science, Veritas University Abuja — 28 November 2026"
---


# 1. Introduction and Objectives

VEIL is a private community chat application that I originally built on the MERN stack
(MongoDB, Express, React, Node.js). Its web version exchanges data through HTTPS REST calls
and a third-party WebSocket service (Pusher). That works well as a product, but it hides
transport-layer behaviour: my own server never accepts or manages a socket.

For this assignment I added a **VEIL TCP Chat** module. Its core messaging uses raw TCP
sockets created with Node.js's built-in `net` module. The server accepts many concurrent
connections, frames messages itself, validates input, and handles orderly (FIN) and abrupt
(RST) disconnections. It is deployed publicly on Render. A WebSocket gateway carries browser and
CLI users over TLS to the same raw TCP server, which runs inside the container.

**Objectives**

1. Implement client–server communication using TCP sockets.
2. Show the roles of IP addresses, port numbers, connections and application-layer message framing.
3. Manage multiple concurrent users and connection lifecycle events.
4. Evaluate TCP against UDP through measurements and packet captures.
5. Deploy and validate the application on a public cloud platform, securely and at minimal cost.

**Repository:** `https://github.com/oladraxler01/discord-modified-api` (branch
`claude/jolly-davinci-db5797`), folder `tcp-chat/`.

# 2. System Requirements

## 2.1 Functional requirements

| ID | Requirement | Where it is implemented |
|---|---|---|
| F1 | Server accepts and manages multiple TCP clients | `server.js`: `net.createServer`, `clients` Map |
| F2 | Client connects using TCP | `client.js`: `net.createConnection` |
| F3 | Users identify with a unique, validated username | `hello` message, `validateUsername()` |
| F4 | Real-time text between ≥ 2 simultaneous users | `msg` broadcast |
| F5 | Group chat **and** one-to-one messaging | `msg` (group room), `dm` |
| F6 | Handle connect, disconnect and unexpected termination | `end`, `error`, `timeout`, `close` handlers; keep-alive |
| F7 | Documented message format | `tcp-chat/PROTOCOL.md` (NDJSON) |
| F8 | Explicit framing that survives split and combined reads | `FrameDecoder` in `protocol.js` |
| F9 | Malformed input never crashes the server; logs are kept | `sendError()`, try/catch per frame, `logs/server.log` |

## 2.2 Non-functional requirements

- **Portability:** Node.js ≥ 18, with zero third-party dependencies for the TCP module.
- **Security:** only the required ports are exposed and no secrets are committed (see §8.3).
- **Cost:** stays inside the cloud provider's free tier.
- **Testability:** automated tests (`npm run tcp:test`) and measurement tools you can rerun.

## 2.3 Environment

| Item | Value |
|---|---|
| Server | Local: Windows laptop. Cloud: Render free web service (Linux container), https://veil-tcp-chat.onrender.com |
| Runtime | Node.js v24.12.0 (laptop) |
| Client machines | Windows laptop (server and clients run as separate processes), PowerShell terminals in VS Code |
| Tools | Wireshark 4.6.10 with Npcap (loopback capture), clumsy 0.3 (packet loss/delay on Windows) |

# 3. System Architecture

![Figure 1 — Application architecture](diagrams/app-architecture.png){width=100%}

Figure 1 shows the TCP chat. It uses a **client–server** model. Each client process opens
one long-lived TCP connection to the server's well-known port **5000**. The operating
system gives the client socket an **ephemeral port** (for example 51234). The server tells
connections apart by the socket 4-tuple *(client IP, client port, server IP, server port)*.
That is why many clients can share server port 5000 at the same time.

Inside the server there is a single Node.js process. Its event loop handles all sockets
without blocking:

1. The **listening socket** (`0.0.0.0:5000`). The kernel completes the three-way handshake
   and then Node emits a `connection` event with a new **connected socket**.
2. **Per-connection settings.** `setNoDelay(true)` disables Nagle's algorithm so short chat
   lines go out immediately. `setKeepAlive(true, 30 s)` detects silently dead peers. An idle
   timeout of 5 minutes closes abandoned connections.
3. **FrameDecoder** turns the byte stream into whole messages (§4.2).
4. **Validation** and the **message router** (`handleMessage`) process each message by its `type`.
5. **Shared state.** A `Map` of connected clients and the last 20 messages.
6. **Lifecycle handlers** clean up on FIN, RST, timeout or close, and tell the remaining users.
7. **Logging** goes to stdout (captured by systemd's journal) and to `tcp-chat/logs/server.log`.

The existing VEIL web application (React on Vercel, Express on Render, MongoDB Atlas, Pusher,
LiveKit) is unchanged and shown greyed out for context. Its HTTPS and WSS traffic also runs
over TCP (port 443), but the protocol work there is done by libraries and third parties.
The TCP Chat module is where I implemented it myself.

# 4. Implementation and Message Protocol

## 4.1 Server and client

**Server (`tcp-chat/server.js`).** Key points:

```js
export const server = net.createServer((socket) => {     // called after the 3-way handshake
  const client = { id, socket, peer: `${socket.remoteAddress}:${socket.remotePort}`,
                   username: null, decoder: new FrameDecoder(), errors: 0 };
  clients.set(client.id, client);
  socket.on("data",  chunk => { for (const r of client.decoder.push(chunk)) ... });
  socket.on("end",   () => { /* peer sent FIN */  socket.end(); });
  socket.on("error", e  => { /* ECONNRESET = peer sent RST */ });
  socket.on("close", () => { clients.delete(client.id); broadcast({type:"left", ...}); });
});
server.listen(PORT, "0.0.0.0");
```

`close` is the single place where cleanup happens. It runs whether the connection ended with
FIN, RST, a timeout or a local error, so no "ghost" users are left behind. A `try/catch` around
each message handler means a bug triggered by one client can't bring down the process.
`SIGINT`/`SIGTERM` trigger a graceful shutdown: the server notifies every client,
`end()`s each socket (sending FIN) and closes the listener.

**Client (`tcp-chat/client.js`).** A terminal client using `readline`. It prints its local and
remote socket addresses when it connects, so the 4-tuple is visible during the demonstration.
Commands: plain text (group message), `/dm <user> <text>`, `/users`, `/ping` (RTT), `/quit`
(graceful, FIN) and `/crash` (abrupt: `socket.resetAndDestroy()` sends a TCP RST). Anything
typed before the server accepts the username is queued and sent after the `welcome` reply.

## 4.2 Why framing is needed, and how it works

TCP delivers an **ordered, reliable byte stream** and keeps no record of where one `write()`
ends and the next begins. A single `write()` can arrive in several `data` events: it may be
split across segments by the MSS, or the receiver may read before everything has arrived.
Several writes can also arrive together in one `data` event (Nagle's algorithm, delayed ACKs,
or the receiver reading late). Treating each `data` event as one message would therefore
corrupt messages at random.

I use **newline-delimited JSON (NDJSON)**. Every message is one JSON object followed by `\n`.
`JSON.stringify` escapes any newline inside a string as the two characters `\` `n`, so a raw
`0x0A` byte can only mean "end of frame".

```js
push(chunk) {
  this.buffer += this.decoder.write(chunk);        // StringDecoder: keeps split UTF-8 chars intact
  while ((i = this.buffer.indexOf("\n")) !== -1) {
    const raw = this.buffer.slice(0, i);
    this.buffer = this.buffer.slice(i + 1);        // keep any remainder for the next read
    results.push(tryParse(raw));                    // { message } or { error }
  }
  if (bytes(this.buffer) > 16 KiB) → fatal "Frame too large"   // memory-exhaustion guard
}
```

Edge cases this handles, all covered by automated tests (§6): a frame split across reads, a
frame delivered **one byte at a time**, several frames in one read, 1.5 frames followed by the
rest, an emoji whose 4 UTF-8 bytes are split across reads, CRLF line endings, invalid JSON
(the frames after it still parse) and an oversized line.

I chose NDJSON over length-prefixing because it is human-readable in Wireshark's "Follow TCP
Stream" and can be typed by hand with `nc`. Length-prefixed binary framing would be more
efficient and wouldn't need escaping, but it is harder to debug.

## 4.3 Message format

Full specification: `tcp-chat/PROTOCOL.md`. Summary:

| Direction | `type` | Fields |
|---|---|---|
| C→S | `hello` | `username` (2–20 chars `[A-Za-z0-9_-]`, unique ignoring case) |
| C→S | `msg` / `dm` | `text` (1–1000 chars), `to` (for `dm`) |
| C→S | `list`, `ping`, `bye` | `ping` carries `t`, which the server echoes |
| S→C | `welcome` | `username`, `connectionId`, `client{ip,port}`, `server{ip,port}`, `users[]`, `history[]` |
| S→C | `msg` | `seq` (server order number), `from`, `text`, `ts` |
| S→C | `joined` / `left` | `username`, `reason` (`quit`, `closed`, `connection_reset`, `timeout`) |
| S→C | `users`, `pong`, `bye`, `error` | `error` has `code` and `message` |

Example exchange (exactly what appears in "Follow TCP Stream"):

```
C→S {"type":"hello","username":"ola"}
S→C {"type":"welcome","username":"ola","connectionId":1,"client":{"ip":"…","port":51234},"server":{"ip":"10.128.0.2","port":5000},"users":["ola"],"history":[]}
C→S {"type":"msg","text":"hi"}
S→C {"type":"msg","seq":1,"from":"ola","text":"hi","ts":1764107000000}
C→S {"type":"bye"}
S→C {"type":"bye"}
```

## 4.4 Validation, error handling and logging

| Bad input | Server response |
|---|---|
| Not JSON / not an object | `error malformed`; the connection stays open |
| Any message before `hello` | `error not_identified` |
| Invalid or duplicate username | `error invalid_username` / `username_taken` |
| Empty or > 1000-char text | `error invalid_text` |
| Unknown `type` | `error unknown_type` |
| 10 errors on one connection | `error too_many_errors`, then FIN |
| Line > 16 KiB without `\n` | `error malformed`, then FIN |

Real log lines from my server during Experiment 3 (see Figure 15):

```
2026-11-26T11:36:06.135Z [INFO] connection_open {"id":1,"peer":"127.0.0.1:1348","local":"127.0.0.1:5000","total":1}
2026-11-26T11:36:06.178Z [INFO] user_joined {"id":1,"peer":"127.0.0.1:1348","username":"normal"}
2026-11-26T11:37:46.691Z [INFO] shutdown {"signal":"SIGINT","clients":1}
2026-11-26T11:37:46.706Z [INFO] peer_fin_received {"id":1,"username":"normal"}
2026-11-26T11:38:06.913Z [INFO] listening {"host":"0.0.0.0","port":5000,"pid":8572}
2026-11-26T11:38:53.458Z [INFO] connection_open {"id":1,"peer":"127.0.0.1:1462","local":"127.0.0.1:5000","total":1}
2026-11-26T11:38:54.046Z [INFO] user_joined {"id":1,"peer":"127.0.0.1:1462","username":"crasher"}
2026-11-26T11:39:01.671Z [WARN] socket_error {"id":1,"username":"crasher","code":"ECONNRESET"}
2026-11-26T11:39:01.690Z [INFO] connection_closed {"id":1,"peer":"127.0.0.1:1462","username":"crasher","reason":"connection_reset","total":0}
```

Starting a second server while the first was still running produced
`server_error {"code":"EADDRINUSE","message":"listen EADDRINUSE: address already in use 0.0.0.0:5000"}`.
Only one process can listen on a given IP:port, so the OS refused the second `bind`.

# 5. TCP versus UDP Analysis

## 5.1 Question 1 — Why is TCP suitable for normal chat messages?

Chat text has to arrive **complete, exactly once and in order**. If "Meet at 5" and "Actually, 6"
arrived swapped, or one went missing, the conversation would be wrong. TCP gives these
properties without any extra application code. Chat traffic is also small and
latency-tolerant: a few extra milliseconds, or around 200 ms during a retransmission, is
barely noticeable to a person, unlike in voice. A connection also gives the server a natural
notion of "who is online": a user is present while their socket is open. My server relies on
that for `joined`/`left` notifications. TCP's flow and congestion control protect slow
clients and shared networks automatically.

## 5.2 Question 2 — What transport-layer guarantees does TCP provide?

- **Connection-oriented communication:** the three-way handshake (SYN, SYN-ACK, ACK) agrees on
  initial sequence numbers and options (MSS, window scaling, SACK) before data flows (Experiment 1).
- **Reliable delivery:** each byte has a sequence number. The receiver acknowledges with
  cumulative ACKs (plus SACK blocks). Lost segments are retransmitted after duplicate ACKs (fast
  retransmit) or a retransmission timeout (RTO) (Experiment 2).
- **In-order delivery and no duplicates:** out-of-order segments are buffered and duplicates
  discarded, so the application reads bytes exactly in the order they were sent.
- **Error detection:** a 16-bit checksum over header and data. Corrupted segments are dropped and later resent.
- **Flow control:** the receiver advertises a receive window (rwnd), so a fast sender can't overflow a slow receiver's buffer (Experiment 4).
- **Congestion control:** the congestion window (cwnd) is adjusted (slow start, congestion
  avoidance, e.g. CUBIC on Linux) to avoid overloading the network.
- **Full-duplex communication and orderly release:** each direction closes independently with FIN/ACK (Experiment 3).

TCP does **not** guarantee message boundaries, a delivery deadline, or that data was processed
by the remote application (§5.9).

## 5.3 Question 3 — Major differences between TCP and UDP

| Property | TCP | UDP |
|---|---|---|
| Connection | Connection-oriented (handshake, teardown) | Connectionless |
| Reliability | ACKs and retransmission | None: best effort |
| Ordering | Guaranteed | Not guaranteed |
| Data unit | Byte stream (no boundaries) | Datagram (boundaries preserved) |
| Flow / congestion control | Yes (rwnd, cwnd) | No |
| Header size | 20–60 bytes | 8 bytes |
| Latency under loss | Higher (waits for retransmission: head-of-line blocking) | Unaffected (lost data simply never arrives) |
| Delivery pattern | Unicast | Unicast, broadcast, multicast |
| Typical uses | Web (HTTP/1.1, HTTP/2), e-mail, SSH, file transfer, chat | DNS, VoIP, video calls, gaming, streaming; QUIC is built on it |

In my implementation the difference shows up directly in the code. The TCP comparison sender
needs `FrameDecoder` because it is a stream. The UDP sender sends one JSON object per
`socket.send()` and the receiver gets exactly one datagram per message, so no framing is needed.

## 5.4 Question 4 — Which parts of a chat application could reasonably use UDP?

Data that is **time-sensitive and replaceable**, where a late copy is worthless and the next
update replaces it:

- **Voice and video calls.** The existing VEIL app already does this: LiveKit carries media
  with WebRTC over UDP (RTP/SRTP). A retransmitted audio frame would arrive too late to play.
- **Typing indicators and presence ("online", "is typing…").** If one is lost, the next update corrects it.
- **Live location or cursor positions, read receipts for non-critical UI, and LAN service discovery.**

Message text, files, login and membership changes must stay on TCP, or on a reliable protocol
built on UDP such as QUIC.

## 5.5 Question 5 — What happens if a UDP message is lost or arrives out of order?

Nothing at the transport layer. UDP has no sequence numbers or ACKs, so the sender is never
told and the datagram is gone. Out-of-order datagrams are passed to the application in the
order they arrive. Any recovery must be built by the application: sequence numbers to detect
gaps and reordering (as my comparison receiver does: `missing[]`, `outOfOrder`), timeouts and
retransmission, or forward error correction. My measurements under 10% emulated loss showed
**87/100** UDP messages received. 13 sequence numbers (1, 9, 14, 24, 30, 33, 36, 37, 83, 87, 91, 92, 98)
never arrived and were never recovered. TCP delivered **100/100** in order over the same
impaired link (§7.5).

## 5.6 Question 6 — How do sockets and port numbers enable process-to-process communication?

An **IP address** identifies a host interface, and routers use it to deliver packets
host-to-host. The **port number** (16 bits in the TCP/UDP header) identifies a *process* on that
host: transport-layer multiplexing and demultiplexing. A **socket** is the operating-system
endpoint that a process uses to send and receive, bound to (IP, port).

In my system the server process calls `listen(5000)`, so the kernel delivers every segment
arriving for port 5000 to it. Each client's kernel picks a free ephemeral port
(**16414** in my Experiment 1 capture, and 1348 and 1462 in Experiment 3). After `accept`, the server holds one connected socket per
client, identified by the 4-tuple, for example
`(127.0.0.1, 16414) ↔ (127.0.0.1, 5000)` in Experiment 1. In my local tests three clients were connected to the same server port at once (Figures 3–6: ports 5911, 5938 and 6012). A TCP connection is
demultiplexed by the full 4-tuple, so ten clients can all talk to port 5000 at once. A UDP
socket is demultiplexed by destination port only. The `welcome` message reports both endpoints
back to the client, so the 4-tuple can be read live during the demonstration. On Render the
chat server sees `127.0.0.1:<ephemeral> → 127.0.0.1:5000` for every user, because each user's TCP
connection is opened by the gateway inside the same container. The user's public IP is visible
only at the gateway (from the `X-Forwarded-For` header) and is logged in `gateway_open`.

## 5.7 Question 7 — What happens when a client disconnects while using TCP?

- **Graceful disconnect (`/quit`, Ctrl+C):** the client sends a `bye` frame. The server replies,
  then both sides exchange **FIN → ACK, FIN → ACK** (a four-way close; FIN and ACK are often
  combined as `FIN, ACK`). Node emits `end` and then `close`. The server removes the user and
  broadcasts `left (quit)`. The side that closes first enters **TIME_WAIT** (2×MSL) so late
  duplicate segments can't be mistaken for a new connection.
- **Abrupt termination (process killed, `/crash`):** the client's OS sends **RST** instead of
  FIN. The server gets `ECONNRESET`, logs `connection_reset` and runs the same cleanup. Any
  unread data is discarded.
- **Silent failure (cable pulled, Wi-Fi lost, laptop sleeps):** no FIN and no RST are sent, so
  the server can't know right away. The connection is only declared dead when (a) the server
  tries to send and its retransmissions time out, (b) TCP keep-alive probes go unanswered
  (enabled after 30 s idle), or (c) my application idle timeout (5 min) fires.

Evidence: Experiment 3 (§7.3).

## 5.8 Why TCP needs application-level message framing

As explained in §4.2, TCP's service is a byte stream. Segment boundaries depend on MSS,
Nagle's algorithm, congestion state and when the receiver reads, not on the application's
`write()` calls. The tests in §6 show one message split across reads and several messages in
one read. Without a delimiter or length prefix the receiver can't know where a message ends.

## 5.9 What TCP cannot guarantee after a connection failure

- **Delivery to the application.** An ACK only means the remote *kernel* received the bytes.
  If the server crashes after ACKing but before processing, the message is lost even though
  the client saw it acknowledged.
- **Knowing which data arrived.** After a reset or timeout the sender can't tell which of its
  last writes were processed. `write()` succeeding only means the data was copied into the local send buffer.
- **Timely detection.** A silent peer is only noticed after keep-alive or retransmission timeouts (from seconds up to about 15 minutes by default on Linux).
- **Continuity.** A new connection is a new byte stream. TCP doesn't resume or replay. My client
  must reconnect and send `hello` again. The server's last-20-messages history partly makes up
  for this, but there are no end-to-end acknowledgements or exactly-once guarantees (see
  Limitations).

## 5.10 How the packet captures support these conclusions

| Claim | Evidence |
|---|---|
| Connection set up by a three-way handshake with random ISNs | Exp 1 capture: SYN / SYN-ACK / ACK, seq/ack values (§7.1) |
| Lost segments are retransmitted with the same sequence number | Exp 2: `tcp.analysis.retransmission` packets (§7.2) |
| Graceful close = FIN exchange; crash = RST | Exp 3 captures and server log (§7.3) |
| Receiver advertises a window; RTT dominates chat performance | Exp 4: window column, `ss -tin`, bench results (§7.4) |
| UDP gives no recovery; TCP does at a latency cost | Comparison table and capture (§7.5) |
| Messages don't line up with segments | Exp 2/4: one TCP segment containing several `\n`-terminated frames (packet 75: 11,873 bytes; packets 2610–2616: up to 65,495 bytes) |

# 6. Testing and Results

## 6.1 Automated tests (`npm run tcp:test`)

| # | Test | Result |
|---|---|---|
| 1 | One complete frame in one read | ✅ Pass |
| 2 | One frame split across multiple reads | ✅ Pass |
| 3 | Frame delivered one byte at a time | ✅ Pass |
| 4 | Several frames combined in a single read | ✅ Pass |
| 5 | 1.5 frames, then the rest | ✅ Pass |
| 6 | Multi-byte UTF-8 (emoji) split across reads | ✅ Pass |
| 7 | Malformed JSON reported; later frames still parse | ✅ Pass |
| 8 | CRLF line endings accepted | ✅ Pass |
| 9 | Oversized frame rejected as fatal | ✅ Pass |
| 10 | Three simultaneous clients exchange group and DM messages | ✅ Pass |
| 11 | Client reconnects while others stay connected | ✅ Pass |
| 12 | Abrupt termination (RST) detected and cleaned up | ✅ Pass |
| 13 | Malformed input and invalid values don't crash the server | ✅ Pass |
| 14 | Frames split across real TCP writes and combined in one write | ✅ Pass |

Total: **14 passed, 0 failed**, both in development (Node.js 22) and on my Windows laptop (Node.js 24.12.0):

```
✔ frames split across TCP writes and combined in one write (91.7769ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3230.2533
```

## 6.2 Manual and cloud tests

See the full test log in `docs/TEST_LOG.md`. Local manual tests on my laptop: two users chatted in both directions, `/ping` measured 1.24 ms RTT, a graceful `/quit` (FIN) and an abrupt `/crash` (RST) were both detected and reported to the other user, and a client reconnected and received the message history while the other user stayed connected.

![Figure 3 — Client “ola”: connects from ephemeral port 5911, sends and receives group messages](screenshots/fig03-local-chat-ola.png){width=70%}

![Figure 4 — Client “bob” on port 5938 receives ola’s message #1 and sends #2](screenshots/fig04-local-chat-bob.png){width=70%}

![Figure 5 — bob quits (FIN received), reconnects on new port 6012, gets history, then sees ola leave with connection_reset](screenshots/fig05-bob-quit-rejoin.png){width=70%}

![Figure 6 — ola measures RTT (1.24 ms), sees bob leave (quit) and rejoin, then disconnects abruptly with /crash](screenshots/fig06-ola-ping-crash.png){width=80%}

# 7. Compulsory TCP Investigations

All captures are in `tcp-chat/experiments/captures/`. Commands are in
`tcp-chat/experiments/EXPERIMENTS.md`, and exact command lines are in Appendix A. Captures use
test usernames and test text only.

## 7.1 Experiment 1 — Connection establishment

**Setup:** server and client both on my Windows laptop, using the loopback interface
(127.0.0.1). The capture was taken in Wireshark 4.6.10 on "Adapter for loopback traffic capture"
(Npcap), with display filter `tcp.port == 5000` and relative sequence numbers turned off, so the
real ISNs are shown. File: `exp1-handshake.pcapng`.
![Figure 7 — exp1-handshake.pcapng: SYN (53), SYN-ACK (54), ACK (55), data frames, keep-alive (122–123) and FIN close (136–139)](screenshots/fig07-exp1-packet-list.png){width=100%}

![Figure 8 — Packet 53 (SYN): src port 16414 → dst port 5000, Seq 282152160, options MSS=65495, WS=256, SACK_PERM](screenshots/fig08-exp1-syn-details.png){width=80%}

| Pkt | Source → Destination | Flags | Seq (raw) | Ack (raw) | Win | Notes |
|---|---|---|---|---|---|---|
| 53 | 127.0.0.1:**16414** → 127.0.0.1:**5000** | SYN | **282152160** (client ISN *x*) | 0 | 65535 | Options: MSS=65495, WS=256 (×256), SACK_PERM |
| 54 | 127.0.0.1:5000 → 127.0.0.1:16414 | SYN, ACK | **1135857521** (server ISN *y*) | 282152161 (*x*+1) | 65535 | Server's own MSS, WS and SACK |
| 55 | 127.0.0.1:16414 → 127.0.0.1:5000 | ACK | 282152161 (*x*+1) | 1135857522 (*y*+1) | 327424 | Handshake done: ESTABLISHED |

**Explanation:** the client process was given ephemeral port **16414** by Windows and connected
to the server's well-known port **5000**. Together the two IP:port pairs form the connection's
4-tuple. The client chose a random initial sequence number x = 282152160. The server replied
with its own random ISN y = 1135857521 and acknowledged x+1: a SYN uses up one sequence number
even though it carries no data (Len=0). The third packet acknowledges y+1, and both sides then
consider the connection established. The whole handshake took about 0.25 ms on loopback
(40.661066 s → 40.661317 s).

The SYN also negotiated options:
- **MSS = 65495:** the largest segment the receiver accepts. This is the loopback MTU of 65535 minus 40 bytes of IP and TCP headers.
- **Window scale = 256:** the 16-bit window field is multiplied by 256. That's why packet 55's `Win=327424` (= 1279 × 256) is larger than 65535.
- **SACK permitted:** selective acknowledgements are allowed.

**The rest of the same capture shows framing and the connection lifecycle:**

| Pkt | Direction | Len (bytes) | Content (Follow TCP Stream) |
|---|---|---|---|
| 56 | client → server | 34 | `{"type":"hello","username":"ola"}` + `\n` (33 + 1) |
| 58 | server → client | 163 | `welcome` frame |
| 92 | client → server | 39 | `{"type":"msg","text":"hello from ola"}` + `\n` |
| 94 | server → client | 79 | broadcast `msg` with `seq: 1` |
| 122–123 | server ↔ client | 1 / 0 | **TCP Keep-Alive** probe and ACK, 30 s after the last data. This is my `socket.setKeepAlive(true, 30000)` working |
| 132 / 134 | both | 15 / 15 | `{"type":"bye"}` + `\n` and the server's reply |
| 136–139 | both | 0 | FIN,ACK → ACK → FIN,ACK → ACK: the graceful four-way close (see §7.3) |

Each `Len` matches the byte length of one JSON object plus its `\n` delimiter, and every data
segment is acknowledged by the receiver. Packet 57 (server) has Ack = 282152161 + 34 = 282152195,
and packet 59 (client) has Ack = 1135857522 + 163 = 1135857685. That is TCP's cumulative acknowledgement counting bytes,
not messages. In this capture each frame happened to fit in its own segment. Experiment 2/4
shows cases where they don't.

## 7.2 Experiment 2 — Packet loss and retransmission

**Setup:** server and `bench.js` on my Windows laptop over loopback. Windows has no `tc netem`,
so I used **clumsy 0.3** (which uses the WinDivert driver) to drop **10%** of packets on port 5000 in both
directions. Filter: `outbound and ip.DstAddr >= 127.0.0.1 and ip.DstAddr <= 127.255.255.255 and
(tcp.DstPort == 5000 or tcp.SrcPort == 5000)`. Wireshark captured on the Npcap loopback adapter
(`exp2-loss.pcapng`). Loss was only applied to my own machine's loopback traffic.

**Observation about the handshake:** when loss was switched on *before* connecting, Windows
failed with `ETIMEDOUT` twice. A lost SYN or SYN-ACK on loopback was not recovered in time. I
added a `--pause` option to `bench.js`, so the connection is established first and loss is
switched on during a countdown. The experiment therefore measures **data retransmission** on an
established connection.

Commands:

```
node tcp-chat/bench.js --label exp2-noloss --pings 100 --messages 300
node tcp-chat/bench.js --label exp2-loss10 --pings 500 --messages 2000 --pause 15   (clumsy Drop 10% started during countdown)
```

| Metric | No loss | 10% loss (clumsy) |
|---|---|---|
| Pings (sequential request/response) | 100 | 500 |
| Pings answered | 100 / 100 | **500 / 500** |
| RTT min (ms) | 0.273 | 0.419 |
| RTT avg (ms) | 0.87 | **166.3** |
| RTT p95 (ms) | 2.24 | **860.7** |
| RTT max (ms) | 4.93 | **8309.1** |
| Burst: messages echoed back, in order | 300 / 300 | **2000 / 2000** |
| Burst time (s) / msg/s | 0.043 / 6974 | 0.242 / 8252 |

![Figure 9 — clumsy running: Drop 10% on loopback traffic to/from port 5000](screenshots/fig09-exp2-clumsy-drop10.png){width=80%}

![Figure 10 — bench.js under 10% loss: avg RTT 166 ms, p95 861 ms, max 8309 ms; all 500 pings and 2000 messages delivered](screenshots/fig10-exp2-bench-loss10.png){width=70%}

![Figure 11 — Previous segment not captured, Dup ACK #2–#6, Fast Retransmission and RTO Retransmission (packets 2608–2626)](screenshots/fig11-exp2-dupack-fast-retransmission.png){width=100%}

![Figure 12 — Filter tcp.analysis.retransmission || tcp.analysis.duplicate_ack: retransmissions in both directions; packet 125 is the retransmitted ping #5](screenshots/fig12-exp2-retransmission-filter.png){width=100%}

**What the capture shows** (around packets 2606–2626):

- **`[TCP Previous segment not captured]`** (e.g. 2610, 2624): Wireshark sees a sequence-number gap. That segment was dropped by clumsy before it reached the receiver.
- **`[TCP Dup ACK 2606#2 … #6]`** (2608–2615): the client (port 2161) keeps acknowledging the same byte, `Ack` stuck at the start of the missing data. It is telling the server "I am still waiting for byte N".
- **`[TCP Fast Retransmission]`** (2614, 2616): after three or more duplicate ACKs the server resends the missing segment immediately, *with the same sequence number*, without waiting for a timeout.
- **`[TCP Retransmission]`** (2626, a `FIN, PSH, ACK`): here no duplicate ACKs could arrive (it was the last segment), so the sender waited for the **retransmission timeout (RTO)** before resending (165.263 s vs the original at 164.933 s, about 330 ms).
- **`[TCP Window Update]`** (2618–2619): once the gap is filled, the receiver delivers the buffered out-of-order data to the application and advertises a larger window again.

**Explanation:** despite 10% loss, **every** ping was answered and all 2000 burst messages
arrived complete and in order. The application saw no loss at all. The cost was latency. The
average RTT rose from 0.87 ms to 166 ms, and the worst case to 8.3 s, because when a segment or
its retransmission is lost again, the RTO doubles each time (exponential backoff). Ping/pong is
hit hardest: each exchange is a single small segment, so there are never three later segments
to trigger duplicate ACKs, and every loss costs a full RTO. The burst was barely slowed, because
many segments were in flight, so losses were repaired quickly by fast retransmit. This is
**head-of-line blocking**: data behind a missing segment waits in the receiver's buffer until the
gap is filled, because TCP must deliver bytes in order.

**Messages vs segments (framing evidence):** in this capture packet 75 carries **11,873 bytes**
of payload (the `welcome` frame including 20 history messages), and packets 2610–2616 carry
segments of up to **65,495 bytes** (the loopback MSS), each holding *many* 537-byte chat frames
back to back. One TCP segment ≠ one message. My `FrameDecoder` split them correctly at each `\n`,
which is why all 2000 messages were counted.

## 7.3 Experiment 3 — Connection termination

**Setup:** loopback on my laptop, Wireshark on the Npcap loopback adapter, filter
`tcp.port == 5000`. Captures: `exp1-handshake.pcapng` (client-initiated graceful close) and
`exp3-termination.pcapng` (server-initiated graceful close, then an abrupt client crash).

![Figure 13 — exp3 capture: keep-alive probes every 30 s, server-initiated FIN close (178–183), new connection (283–289) and RST from /crash (320, red)](screenshots/fig13-exp3-fin-and-rst.png){width=100%}

![Figure 14 — Client terminals: “normal” receives server_shutdown + FIN; “crasher” disconnects with /crash](screenshots/fig14-exp3-client-terminals.png){width=75%}

![Figure 15 — Server log: peer_fin_received for “normal”; socket_error ECONNRESET → connection_closed reason=connection_reset for “crasher”](screenshots/fig15-exp3-server-log.png){width=75%}

**Case 1: graceful close started by the client (`/quit`), from `exp1-handshake.pcapng`**

| Pkt | Direction | Flags | Meaning |
|---|---|---|---|
| 132 | client → server | PSH, ACK, Len=15 | `{"type":"bye"}\n` |
| 134 | server → client | PSH, ACK, Len=15 | server replies `bye`, then calls `socket.end()` |
| 136 | server → client | **FIN, ACK** | server has no more data to send |
| 137 | client → server | ACK | acknowledges the server's FIN |
| 138 | client → server | **FIN, ACK** | client closes its direction too |
| 139 | server → client | ACK | connection fully closed |

**Case 2: graceful close started by the server (Ctrl+C → SIGTERM/SIGINT handler), `exp3-termination.pcapng`, client "normal" on port 1348**

| Pkt | Direction | Flags | Meaning |
|---|---|---|---|
| 178 | server → client | PSH, ACK, Len=79 | `{"type":"error","code":"server_shutdown",…}` |
| 180 | server → client | **FIN, ACK** | server's `socket.end()` |
| 181 | client → server | ACK | |
| 182 | client → server | **FIN, ACK** | client prints "Server closed the connection (FIN received)" |
| 183 | server → client | ACK | |

Server log: `shutdown {"signal":"SIGINT","clients":1}`, then `peer_fin_received {"username":"normal"}`.

**Case 3: abrupt termination (`/crash` = `socket.resetAndDestroy()`), same capture, client "crasher" on port 1462**

| Pkt | Direction | Flags | Meaning |
|---|---|---|---|
| 283–285 | both | SYN / SYN, ACK / ACK | new connection (new ephemeral port 1462) |
| 286 | client → server | PSH, ACK, Len=38 | `{"type":"hello","username":"crasher"}\n` |
| 288 | server → client | PSH, ACK, Len=170 | `welcome` |
| **320** | client → server | **RST, ACK** | the connection is torn down immediately: no FIN and no reply expected |

Server log (real output):

```
2026-11-26T11:39:01.671Z [WARN] socket_error {"id":1,"username":"crasher","code":"ECONNRESET"}
2026-11-26T11:39:01.690Z [INFO] connection_closed {"id":1,"peer":"127.0.0.1:1462","username":"crasher","reason":"connection_reset","total":0}
```

**Comparison**

| | Graceful (FIN) | Abrupt (RST) |
|---|---|---|
| Packets | 4 (FIN, ACK, FIN, ACK). Each direction is closed separately (half-close) | 1 (RST). Both directions die at once |
| Data in flight | Delivered first: FIN comes *after* all data (e.g. `bye` and `server_shutdown` arrived before the FIN) | Any unsent or unread data is discarded |
| Server event | `'end'` → `peer_fin_received` → `'close'` | `'error'` with `ECONNRESET` → `'close'` |
| Logged reason | `quit` / `closed` | `connection_reset` |
| TIME_WAIT | Yes, on the side that sent the first FIN (here the server, packets 136 and 180), for 2×MSL | No: RST skips TIME_WAIT |

**Server-side cleanup:** in all three cases the `'close'` handler ran. It removed the client
from the `clients` Map (so the username can be reused), logged the reason and broadcast `left` to
the remaining users. `total` dropped back to 0 in the log, so no connection state was leaked.

**Keep-alive (bonus observation):** packets 82/83, 124/125 and 162/163 are `[TCP Keep-Alive]`
probes from the server (port 5000) exactly 30 s apart while the "normal" client was idle, each
answered by a `[TCP Keep-Alive ACK]`. This is `socket.setKeepAlive(true, 30000)`. If the client
had disappeared silently (Wi-Fi off, no FIN and no RST), these probes would go unanswered and the
OS would eventually report the connection dead. That is the only way the server can detect that case.

## 7.4 Experiment 4 — Flow control and performance

**Setup:** `bench.js` against the chat server on my laptop (loopback). Each run measures (a) RTT
over sequential ping/pong frames and (b) throughput as a burst of 512-character chat messages
echoed back by the server. The two test conditions are a normal link and a link with **10%
packet loss** (clumsy). Window sizes were examined in `exp4-perf.pcapng`.

| Condition | Pings | RTT min | RTT avg | RTT p95 | RTT max | Burst msgs | Burst time | Msg/s | KB/s sent |
|---|---|---|---|---|---|---|---|---|---|
| **A — normal loopback** (`exp2-noloss`) | 100 | 0.273 ms | **0.87 ms** | 2.24 ms | 4.93 ms | 300 | 0.043 s | **6974** | 3657 |
| **B — 10% loss** (`exp2-loss10`) | 500 | 0.419 ms | **166.3 ms** | 860.7 ms | 8309 ms | 2000 | 0.242 s | **8252** | 4328 |

A third run with clumsy's *Lag 100 ms* (`exp4-delay100`: RTT avg 1.68 ms, 2350 msg/s) did not show
the expected ~200 ms RTT. The lag function did not take effect on loopback traffic in my setup,
so I don't rely on it.

**Latency:** loss raised the average RTT about 190× and the worst case over 1,600×. A single lost
ping frame cannot be repaired by fast retransmit (no later segments generate duplicate ACKs),
so it waits for the retransmission timeout. Repeated losses double the RTO each time
(exponential backoff), which explains the 8.3 s maximum.

**Throughput:** the burst in condition B still delivered all 2000 messages in order. Its rate was
not lower than A, because (i) on loopback the bandwidth is effectively unlimited and RTT is
tiny, (ii) the burst sends many full segments back to back, so lost segments are recovered
quickly by fast retransmit (Experiment 2 capture), and (iii) the bursts differ in size (300 vs
2000), so per-run start-up costs weigh differently. On a real long-RTT path, loss would also
shrink the congestion window and reduce throughput. Loopback can't show that effect.

**Receive window (flow control):**

![Figure 16 — exp4-perf.pcapng: client (2310) ACKs during the 500-message burst, Win values shrinking, then FIN close](screenshots/fig16-exp4-burst-acks.png){width=100%}

![Figure 17 — Packet 1400: raw window bytes 0x20B3 = 8371, × scale 256 = Win 2,142,976 bytes](screenshots/fig17-exp4-window-packet1400.png){width=75%}

- In the SYN the endpoints negotiated **window scale = 256** (Experiment 1). The 16-bit window field
  is therefore multiplied by 256.
- Packet 1400 (client port 2310 → server 5000, ACK) carries the raw window value
  `0x20B3 = 8371`, so the **calculated window = 8371 × 256 = 2,142,976 bytes (≈ 2 MB)**.
- During the 500-message burst (packets 1399–1412) the client's advertised window falls from about
  2,143,7xx to about 2,116,6xx bytes as received data waits in the socket buffer, then rises
  again once Node reads it. This is flow control: the receiver keeps telling the sender how
  much space is free. The window never came close to zero, so **flow control never throttled
  the sender** in these tests. The receiving application (Node's event loop) drains the buffer
  faster than the burst fills it. A `[TCP Window Update]` was observed in Experiment 2 after a
  retransmission filled a gap and the buffered out-of-order data was released to the application.

**Conclusion:** for a chat application, performance is dominated by **latency and loss
recovery**, not by bandwidth or the receive window. Small messages are sent one at a time and
each user waits for the round trip. TCP's reliability costs very little on a clean link but
causes large, user-visible delays under loss.

## 7.5 TCP versus UDP practical comparison

**Method:** a separate tool, not part of the chat (`tcp-chat/compare/`). `receiver.js` listens on
UDP 6001 and TCP 6002. `sender.js` sends **100 numbered messages** (`{"type":"data","seq":n,…}`),
one every 20 ms, and the receiver echoes each one back so the sender measures RTT with a single
clock. For each protocol I ran a **baseline** and then **10% loss**: clumsy *Drop 10%* with
filter `outbound and ip.DstAddr >= 127.0.0.1 and ip.DstAddr <= 127.255.255.255 and (udp.DstPort
== 6001 or udp.SrcPort == 6001 or tcp.DstPort == 6002 or tcp.SrcPort == 6002)`, switched on
after the TCP connection was established (`--pause 10`). Results are in
`tcp-chat/compare/results/*.json|csv` and `RESULTS.md` (from `node tcp-chat/compare/summarize.js`).

Commands (Windows, loopback):

```
node tcp-chat/compare/receiver.js --proto udp --port 6001 --label baseline   (then --label loss10)
node tcp-chat/compare/receiver.js --proto tcp --port 6002 --label baseline   (then --label loss10)
node tcp-chat/compare/sender.js --proto udp --port 6001 --count 100 --label baseline
node tcp-chat/compare/sender.js --proto tcp --port 6002 --count 100 --label baseline
node tcp-chat/compare/sender.js --proto udp --port 6001 --count 100 --label loss10 --pause 10
node tcp-chat/compare/sender.js --proto tcp --port 6002 --count 100 --label loss10 --pause 10
node tcp-chat/compare/summarize.js
```

**Raw results** (Figure 18 shows the summarize.js output):

![Figure 18 — Output of compare/summarize.js — TCP vs UDP, baseline and 10% loss; plus bench results](screenshots/fig18-tcp-vs-udp-results.png){width=100%}


| Condition | Protocol | Sent | Received (unique) | Loss % | Missing seq numbers | Duplicates | Out of order | RTT avg ms | RTT p95 ms | RTT max ms |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | TCP | 100 | 100 | 0 | none | 0 | 0 | 0.594 | 1.075 | 4.123 |
| baseline | UDP | 100 | 100 | 0 | none | 0 | 0 | 0.774 | 1.358 | 4.487 |
| 10% loss | TCP | 100 | **100** | **0** | none | 0 | 0 | **18.19** | **87.73** | **128.28** |
| 10% loss | UDP | 100 | **87** | **13** | 1, 9, 14, 24, 30, 33, 36, 37, 83, 87, 91, 92, 98 (13 total) | 0 | 0 | 1.634 | 2.726 | 6.44 |

**Discussion:**

- **Baseline:** both protocols delivered 100/100 in order with sub-millisecond average RTT. On a
  clean link, TCP's extra machinery costs nothing visible.
- **Under 10% loss, UDP** delivered 87/100. The 13 missing messages, including the very first
  one (seq 1), were simply gone. UDP gave no error, no retransmission and no notification, and
  the receiver only knew because of my sequence numbers. Its RTT stayed low (1.6 ms average),
  because nothing ever waits for a lost packet.
- **Under 10% loss, TCP** delivered **all 100, in order, without duplicates**. The cost was
  latency: average RTT rose about 30× (0.59 → 18.2 ms), and the worst message took 128 ms,
  because it waited for retransmission.
- **Recovery:** TCP recovered every loss automatically (Experiment 2 shows how: duplicate ACKs,
  fast retransmit, RTO). UDP recovered none.
- The measured UDP loss (13%) is higher than the configured 10%: random variation over only 100
  samples.

**What these results do and do not prove:**

- They **do** show the core trade-off: TCP gives completeness and order at the cost of delay
  under loss, while UDP keeps latency low but loses data silently.
- They **do not** prove behaviour on real networks. clumsy drops packets at random and
  independently on loopback. Real loss tends to come in bursts, linked to congestion and queues,
  and adds real propagation delay.
- **100 messages is a small sample.** Repeating the runs would give confidence intervals.
- **No out-of-order UDP arrivals were seen**, but that is because loopback doesn't reorder packets.
  It does **not** mean UDP preserves order.
- UDP's echo-based RTT only covers messages whose request *and* echo both survived. The
  receiver's count (87) is the correct one-way delivery figure.
- The "one-way latency" values (e.g. −1 ms for TCP) are rounding artefacts of the
  millisecond-resolution clock on Windows. The sender's high-resolution RTT is the reliable
  latency metric.

# 8. Cloud Deployment

![Figure 2 — Cloud deployment architecture](diagrams/cloud-architecture.png){width=100%}

## 8.1 Provider choice and services

My first plan was a Google Cloud Compute Engine VM (e2-micro, Always Free). This would have
exposed raw TCP port 5000 directly. Account activation failed: Google Cloud requires card
verification, and both my virtual card and a second card were rejected (Figure 19 shows the
project with no billing account, so Compute Engine could not be enabled). With the lecturer's
permission to use **Render**, which I already use for the VEIL web API and which needs no card for
its free tier, I deployed there. The complete GCP plan is kept in `tcp-chat/deploy/DEPLOY.md`.

![Figure 19 — Google Cloud billing account management: no billing account could be created, so Compute Engine could not be enabled](screenshots/fig19-gcp-no-billing-account.png){width=60%}

| Service | Why |
|---|---|
| **Render Web Service (Free instance)** | No card needed, $0. Builds directly from my GitHub branch and redeploys on every push. Gives a managed HTTPS domain. |
| **Render edge proxy** | The only public entry point. It publishes **TCP 443** (HTTPS/WSS) with a managed TLS certificate, plus 80 (redirect). |
| **`tcp-chat/gateway.js`** | Render can't publish an arbitrary raw TCP port, so the gateway accepts WebSocket connections on `$PORT` and, **for each user, opens its own raw TCP socket** to the chat server on `127.0.0.1:5000` in the same container. |
| **Render Logs / Health check** | stdout of both components (`gateway_open`, `connection_open`, `connection_closed`, …). `/health` is used by the platform to decide if the service is up. |

The browser is allowed to use WebSockets (§6 of the assignment) because **WebSockets run over
TCP**. A WebSocket starts as an HTTP/1.1 `Upgrade` request on an existing TCP connection (here
TLS over TCP 443). After the `101 Switching Protocols` response, the same TCP connection carries
WebSocket frames in both directions. WebSocket has its **own message framing** (each frame
carries a length), so the gateway converts each WebSocket message into exactly one
newline-terminated NDJSON frame on the raw TCP socket, and decodes TCP frames back into
WebSocket messages using the same `FrameDecoder`. The TCP server code, validation and FIN/RST
handling are identical to local testing. Every user is still one TCP connection to `server.js`.

**Public access:**

- Web: **https://veil-tcp-chat.onrender.com**
- CLI:

  ```bash
  node tcp-chat/client.js --url wss://veil-tcp-chat.onrender.com/ws --name <yourname>
  ```

- Raw TCP from the Internet is **not** offered on Render (port 5000 is bound to 127.0.0.1). For raw-TCP
  tests, run `npm run tcp:server` locally and connect with `--host/--port` (all four experiments did this).

## 8.2 Provisioning, deployment and operation

1. Render dashboard → **New → Web Service** → repository `discord-modified-api`.
2. Branch `claude/jolly-davinci-db5797`, Runtime Node, Build `npm install`, Start
   `node tcp-chat/gateway.js`, Instance **Free**, Health check `/health`. No environment
   variables: Render injects `PORT`, and the chat needs no secrets.
3. **Create Web Service.** The first deploy took 38.4 s and showed *Deploy succeeded · Live*
   (26 Nov 2026, 14:00 GMT+1).

| Operation | How |
|---|---|
| Start / deploy | Automatic on every push to the branch, or **Manual Deploy** |
| Restart | **Manual Deploy → Restart service**. Render sends SIGTERM, and `gateway.js` closes all WebSockets (code 1001), ends every TCP socket (FIN) and exits |
| Logs | Service → **Logs** |
| Shutdown | **Settings → Suspend Web Service** |
| Safe cleanup | **Settings → Delete Web Service** (removes the build, URL and logs; nothing else is billed) |
| Local run of the same build | `npm run tcp:gateway`, then open http://localhost:8080 |

Full guide: `tcp-chat/deploy/RENDER.md`.

## 8.3 Evidence: two users on different networks

On 26 Nov 2026, user **ola** (laptop, home Wi-Fi, Chrome) and user **James** (phone on **LTE
mobile data**) were connected to https://veil-tcp-chat.onrender.com at the same time. ola sent
`#1 hello`, James joined, received it as history and replied `#2 How are you doing`, which ola
received live. Both users appear in the Online list. ola's **Ping** measured **RTT 256 ms** for
browser → Render → TCP chat server → back. That compares with about 1 ms on loopback (§7.4) and shows the
real Internet path (Nigeria ↔ Render's data centre).

![Figure 20 — Phone on LTE: user James connected to veil-tcp-chat.onrender.com (TCP connection #539 via the gateway), receives ola’s message and replies](screenshots/fig20-cloud-phone-lte.jpg){width=45%}



**Unexpected evidence (Render logs):** the Render logs show many short connections to
`127.0.0.1:5000` that send non-JSON data. These come from Render's own internal port detection
probing the listening ports inside the container, which is also why the connection numbers
reached #469 and #539. My server rejected every probe with
`client_error code=malformed "Invalid JSON."`, then logged `peer_fin_received` (orderly close) or
`socket_error ECONNRESET` (reset) and cleaned up with `total` back to 0. This is a real-world test
of malformed input and abrupt termination: the server never crashed.

## 8.4 Security

- **Exposed ports:** only TCP 443 (HTTPS/WSS) and 80 (redirect) are published by Render's edge.
  The raw TCP chat port 5000 is bound to **127.0.0.1**, so it isn't reachable from the Internet.
  There is no SSH and no admin port. Administration is only through the Render dashboard
  (HTTPS, account login). There are no firewall rules to configure, because Render's edge acts
  as the network entry point and publishes nothing else.
- **TLS:** yes, for the public hop. Browsers and the CLI use `https://`/`wss://` with Render's
  managed certificate. **Limitation:** TLS is terminated at Render's edge. The edge →
  container hop is inside Render's network, and the gateway → chat-server hop is plaintext on
  loopback. The raw TCP mode used for the experiments is plaintext on purpose, so payloads
  are visible in Wireshark.
- **Secrets:** the chat needs none. Configuration (`PORT`, `TCP_PORT`) comes from environment
  variables. The VEIL web API's MongoDB, Pusher, Firebase and LiveKit credentials stay in its own
  Render service's environment settings. `.env` files are git-ignored and `.env.example` lists
  the names only. Credentials that appeared in early Git history of the VEIL backend should be
  rotated (noted in the README).
- **Input hardening:** the WebSocket `maxPayload` is 16 KiB, plus the TCP-side limits (16 KiB frame,
  1000-char text), validation, a per-connection error budget, and dead-WebSocket detection (ping
  every 25 s).
- **No user authentication** on the chat: anyone with the URL can pick an unused name (see Limitations).

## 8.5 Cost

| Resource | Plan | Cost |
|---|---|---|
| Render Web Service `veil-tcp-chat` | Free instance (512 MB RAM, shared CPU); free instance-hours per workspace each month | $0 |
| Bandwidth | Within the free allowance (chat frames are a few hundred bytes) | $0 |
| TLS certificate, domain `*.onrender.com` | Included | $0 |

**Estimated cost: $0.00 per month.** No payment method is attached, so the service can't
create charges. It is suspended or stopped instead. The free tier spins the service down after
about 15 minutes without traffic, and the next visit takes up to about 50 s while it wakes. I open the
URL a minute before demonstrations. The abandoned GCP plan was also $0 within Always Free
(`DEPLOY.md`), but could not be activated without card verification.

# 9. Challenges and Limitations

**Challenges**

- Recognising that the original VEIL design (REST plus a third-party WebSocket service) could not
  show transport-layer handling, and adding a dedicated TCP layer without breaking the existing app.
- Framing edge cases: a multi-byte UTF-8 character split across reads corrupted text until I used `StringDecoder`.
- Telling the three disconnect cases apart (FIN, RST, silent) and making cleanup run in exactly one place.
- **Packet loss on Windows:** Linux `tc netem` isn't available on Windows, so I used clumsy. With loss switched on *before* connecting, every connection attempt failed with `ETIMEDOUT`: a lost SYN on Windows loopback was not retried successfully. I added a `--pause` option so loss is switched on after the handshake.
- **clumsy Lag:** the 100 ms delay function had no measurable effect on loopback (RTT stayed ~1.7 ms), so Experiment 4 uses loss as its second condition instead.
- **`EADDRINUSE`:** I started the server twice. The first instance still held port 5000, which showed that only one process can listen on an IP:port.
- **Cloud account verification:** card verification failed for the cloud provider sign-up (see §8).

**Limitations**

1. **No encryption or authentication** on the TCP chat. Usernames aren't verified (anyone can
   claim any free name). The VEIL web app uses Firebase authentication, but the TCP module does not.
2. **In-memory state:** history and users are lost on restart, and a single process can't scale horizontally.
3. **No end-to-end acknowledgements:** if a connection fails, a client can't know which of its last messages were broadcast (§5.9).
4. **The client doesn't reconnect automatically.** Reconnection is manual (run it again and rejoin).
5. **Experiments use emulated loss and delay** on loopback, and a small sample size (§7.5).
6. **Single free instance on Render.** There is no redundancy. It sleeps when idle, state is lost on restart, and raw TCP is only reachable inside the container, so packet captures were made locally rather than on the cloud host.
7. **Extra hop in the cloud path:** browser users reach the TCP server through the WebSocket gateway, so the cloud RTT includes TLS, the Render proxy and the gateway.

# 10. Conclusion

The VEIL TCP Chat shows the transport layer at work. Each user is a TCP connection identified
by IP addresses and ports. The server multiplexes many clients on port 5000. Newline-delimited
JSON framing turns TCP's byte stream into discrete messages. Connection lifecycle events (FIN,
RST, timeouts) are detected and cleaned up reliably. The packet captures confirmed the
three-way handshake, retransmission under loss, and the difference between graceful and abrupt
termination. The UDP comparison showed TCP trading latency for reliability and ordering, which
suits chat text, while UDP fits real-time, replaceable data such as voice, which VEIL already
carries over WebRTC. The system is deployed at no cost on Render. Only HTTPS/WSS (443) is public, and a
WebSocket gateway gives every browser or CLI user their own TCP connection to the chat server.

# 11. References

1. W. Eddy (ed.), *RFC 9293: Transmission Control Protocol (TCP)*, IETF, 2022.
2. J. Postel, *RFC 768: User Datagram Protocol*, IETF, 1980.
3. V. Paxson, M. Allman, J. Chu, M. Sargent, *RFC 6298: Computing TCP's Retransmission Timer*, IETF, 2011.
4. D. Borman, B. Braden, V. Jacobson, R. Scheffenegger, *RFC 7323: TCP Extensions for High Performance*, IETF, 2014.
5. I. Fette, A. Melnikov, *RFC 6455: The WebSocket Protocol*, IETF, 2011.
6. J. F. Kurose, K. W. Ross, *Computer Networking: A Top-Down Approach*, 8th ed., Pearson, 2021, ch. 3.
7. Node.js documentation, "net — TCP" and "dgram — UDP", https://nodejs.org/api/
8. Linux man page `tc-netem(8)`; Wireshark User's Guide, https://www.wireshark.org/docs/
9. Render, "Deploy for Free" and "Web Services" documentation, https://render.com/docs/free
10. Google Cloud, "Free cloud features and trial offer", https://cloud.google.com/free/docs/free-cloud-features

# Appendix A — Key commands

```bash
# Run and test
npm run tcp:server
npm run tcp:test
node tcp-chat/client.js --host <EXTERNAL-IP> --port 5000 --name ola

# Captures (on VM)
sudo ./tcp-chat/experiments/capture.sh exp1-handshake "tcp port 5000"
sudo ./tcp-chat/experiments/netem.sh loss 10      # ... then: netem.sh clear
node tcp-chat/bench.js --host 127.0.0.1 --port 5000 --label A-loopback
./tcp-chat/compare/run-all.sh
node tcp-chat/compare/summarize.js
ss -tin 'sport = :5000'
```

Commands actually run on my laptop (26 Nov 2026):

```
npm run tcp:test
npm run tcp:server
node tcp-chat/client.js --name ola          # and --name bob, normal, crasher
node tcp-chat/bench.js --label exp2-noloss --pings 100 --messages 300
node tcp-chat/bench.js --label exp2-loss10 --pings 500 --messages 2000 --pause 15
node tcp-chat/bench.js --label exp4-delay100 --pings 50 --messages 500 --pause 15
node tcp-chat/compare/receiver.js --proto udp --port 6001 --label baseline|loss10
node tcp-chat/compare/receiver.js --proto tcp --port 6002 --label baseline|loss10
node tcp-chat/compare/sender.js --proto udp --port 6001 --count 100 --label baseline|loss10 [--pause 10]
node tcp-chat/compare/sender.js --proto tcp --port 6002 --count 100 --label baseline|loss10 [--pause 10]
node tcp-chat/compare/summarize.js
```

Wireshark display filters used: `tcp.port == 5000`, `tcp.analysis.retransmission || tcp.analysis.duplicate_ack`.

# Appendix B — Screenshots

| Figure | File | Shows |
|---|---|---|
| 1 | diagrams/app-architecture.png | Application architecture |
| 2 | diagrams/cloud-architecture.png | Cloud deployment architecture |
| 3–6 | screenshots/fig03–06 | Local multi-user chat, ping, quit, reconnect, crash |
| 7–8 | screenshots/fig07–08 | Experiment 1: three-way handshake |
| 9–12 | screenshots/fig09–12 | Experiment 2: loss and retransmission |
| 13–15 | screenshots/fig13–15 | Experiment 3: FIN vs RST, server cleanup |
| 16–17 | screenshots/fig16–17 | Experiment 4: receive window |
| 18 | screenshots/fig18 | TCP vs UDP comparison table |
| 19 | screenshots/fig19 | GCP project without a billing account (card verification failed) |
| 20 | screenshots/fig20 | Live cloud chat: phone on LTE |

Packet captures submitted: `exp1-handshake.pcapng`, `exp2-loss.pcapng`, `exp3-crash.pcapng`, `exp4-perf.pcapng`.

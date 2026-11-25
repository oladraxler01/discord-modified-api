# Assignment checklist — VEIL vs "Multi-User TCP Chat Application"

Legend: ✅ have it · 🟡 partly / needs rewording or evidence · ❌ missing

## Key finding

VEIL is a full chat app, but its real-time messaging runs over **HTTP REST + Pusher**
(a third-party WebSocket service). The assignment says the *core messaging must be
TCP socket-based* and that *your server* must handle the connections. With Pusher,
your server never holds a socket, so you cannot show your own `accept()`, framing,
FIN/RST handling, etc. It must also be deployed on **AWS, Azure or GCP**
(Render/Vercel do not count).

**Plan:** keep VEIL as is and add a `tcp-chat/` module to the backend repo: your own
Node.js `net` TCP chat server, CLI client, framing, UDP comparison tools and test
scripts. Deploy it on a free-tier cloud VM. Optionally add a WebSocket bridge so the
VEIL web UI can join the same TCP chat (WebSockets are allowed if you explain they run over TCP).

## 3. Application requirements

| Requirement | VEIL today | Status | What we add |
|---|---|---|---|
| Server accepts & manages multiple client connections | Express handles stateless HTTP requests; Pusher holds the sockets | ❌ | `tcp-chat/server.js` (`net.createServer`, connection registry) |
| Client connects to server using TCP | Browser → HTTPS (TCP underneath) + Pusher WSS | 🟡 | `tcp-chat/client.js` CLI client (raw TCP) |
| User identification (username/nickname) | Google sign-in / Firebase display name | 🟡 | `hello` handshake with validated, unique username |
| Real-time text between ≥2 simultaneous users | Yes (via Pusher) | 🟡 | Broadcast over our own sockets |
| Group chat or 1:1 | Both (channels, DMs) | ✅ concept | Group room + `/dm` in TCP server |
| Handle connect / disconnect / unexpected termination | Not at socket level | ❌ | `end` (FIN), `error` ECONNRESET (RST), keep-alive, idle timeout, cleanup |
| Documented message format | JSON REST bodies, not documented as a protocol | 🟡 | NDJSON protocol spec (`tcp-chat/PROTOCOL.md`) |
| Written transport-layer explanation | No | ❌ | Report |
| Explicit message framing; split/combined reads | Not applicable (HTTP does it) | ❌ | `FrameDecoder` (newline-delimited JSON) + tests |
| Validate usernames/messages, malformed input doesn't crash | Partial validation on REST routes | 🟡 | Per-message validation, error replies, size limits |
| Server connection/error logs | `console.error` only | 🟡 | Timestamped log to console + `logs/server.log` |
| Test ≥3 simultaneous clients incl. join/reconnect | No | ❌ | Automated integration test + manual test log |

## 4. TCP/UDP analysis & experiments

| Item | Status | What we add |
|---|---|---|
| Questions 1–7 | ❌ | Report section (I'll draft, using your code as examples) |
| Exp 1: SYN / SYN-ACK / ACK capture | ❌ | Wireshark/tcpdump commands + annotated screenshot |
| Exp 2: Packet loss & retransmission (`tc netem`) | ❌ | Script with `tc netem loss` commands, capture |
| Exp 3: Normal disconnect (FIN) vs abrupt (RST) | ❌ | Client `/quit` vs `/crash` (kill socket), capture + server log |
| Exp 4: Latency/RTT & throughput under 2 conditions, rwnd | ❌ | `tcp-chat/bench.js` (ping RTT + throughput) |
| Separate UDP sender/receiver, 100 numbered msgs, TCP vs UDP, baseline vs loss | ❌ | `tcp-chat/compare/` tools writing JSON/CSV results |
| Explain framing need, what TCP can't guarantee after failure, capture evidence | ❌ | Report |

## Cloud security & cost

| Item | VEIL today | Status | What we add |
|---|---|---|---|
| Firewall: only required ports, restricted admin (SSH) | Render/Vercel managed | ❌ | GCP/AWS firewall rule: TCP 5000 open, SSH 22 only from your IP |
| TLS statement | HTTPS via Render/Vercel | 🟡 | Explain raw TCP chat is plaintext (for capture visibility) + limitation |
| Secrets via env vars | ✅ `.env.example`, dotenv | ✅ | Reuse; TCP server needs no secrets |
| Startup / restart / shutdown / cleanup docs | No | ❌ | systemd unit + deploy guide |
| Free-tier check, spending alert, cost estimate | No | ❌ | Report section |

## 5. Cloud deployment (AWS / Azure / GCP)

| Item | Status | What we add |
|---|---|---|
| Deployed on AWS/Azure/GCP | ❌ (Render + Vercel) | GCP e2-micro or AWS EC2 t2/t3.micro VM |
| Public hostname/IP + port | ❌ | VM external IP : 5000 |
| Labeled cloud architecture diagram | ❌ | Diagram (Mermaid/draw.io) |
| Step-by-step provisioning guide | ❌ | `tcp-chat/DEPLOY.md` |
| Evidence ≥2 users exchange messages on deployment | ❌ | Screenshots (you take them) |
| Why these cloud services | ❌ | Report |

## 6. Implementation rules

| Rule | Status |
|---|---|
| Core messaging is TCP socket-based | ❌ → fixed by `tcp-chat/` |
| Browser UI may use WebSockets if explained | 🟡 VEIL uses Pusher (third-party); optional bridge fixes this |
| UDP only for optional features / comparison | ✅ we use it only in comparison tools |
| No secrets committed | 🟡 Old commits contained Mongo/Pusher secrets — rotate them; README already warns |
| ≥2 users simultaneously | ✅ |

## 7. Required submission

| # | Deliverable | Status | Who |
|---|---|---|---|
| 1 | Git repo + README with setup/run | 🟡 | Me: `tcp-chat/README.md` |
| 2 | Technical report | ❌ | Me drafts, you review/personalise |
| 3 | App architecture diagram + cloud diagram | ❌ | Me |
| 4 | Screenshots / recording, 2 users on deployed system | ❌ | **You** (after deploy) |
| 5 | Live demo (connect, message, disconnect) | ❌ | **You** — practise with the CLI client |
| 6 | .pcap files + annotated screenshots for 4 experiments | ❌ | **You** run captures (needs Wireshark/Linux); I give exact commands |
| 7 | TCP/UDP comparison table, raw results, commands | ❌ | Tools by me, you run & paste results |
| 8 | Test log (simultaneous, reconnect, malformed, split/combined, cloud) | ❌ | Automated tests by me + manual log template |

## Order of work (deadline Saturday)

1. **Wed** — TCP server, client, framing, tests (core). ✅ done
2. **Wed/Thu** — UDP/TCP comparison tools, bench tool, experiment scripts. ✅ done (`compare/`, `bench.js`, `experiments/`)
3. **Thu** — Deploy on GCP/AWS free tier, firewall, systemd. Take 2-user screenshots. 🟡 guide ready (`tcp-chat/deploy/DEPLOY.md`), you run it
4. **Thu/Fri** — Run 4 Wireshark experiments + comparison, collect .pcap/screenshots.
5. **Fri** — Report, diagrams, test log. Optional: VEIL web UI bridge.
6. **Sat** — Rehearse demo: change port live, explain framing, FIN vs RST.

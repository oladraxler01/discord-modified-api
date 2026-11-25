# Test log — VEIL TCP Chat

Tester: `[FILL: your name]` · Server build: commit `[FILL: git rev-parse --short HEAD]` ·
Server endpoint: `[FILL: EXTERNAL-IP]:5000` (cloud) and `127.0.0.1:5000` (local)

Status key: ✅ pass · ❌ fail · ⏳ not run yet

## A. Automated tests (`npm run tcp:test`)

Run on: Linux container, Node.js v22.23.5, 25 Nov 2026. Result: **14/14 passed**.
`[FILL: re-run on your machine and attach a screenshot]`

| ID | Category | Test | Expected | Result |
|---|---|---|---|---|
| A1 | Framing | One complete frame in one read | 1 message | ✅ |
| A2 | Framing (split) | One frame split across 3 reads | Nothing until the last part, then 1 message | ✅ |
| A3 | Framing (split) | Frame delivered one byte at a time | 1 message at the final `\n` | ✅ |
| A4 | Framing (combined) | 3 frames in one read | 3 messages, in order | ✅ |
| A5 | Framing (both) | 1.5 frames, then the rest | 1 message, then 1 message | ✅ |
| A6 | Framing (UTF-8) | Emoji bytes split across reads | Text intact ("héllo 👋") | ✅ |
| A7 | Malformed | `{not json}`, `[1,2]`, then a valid frame | 2 errors, then the valid message | ✅ |
| A8 | Framing | CRLF line ending | Accepted | ✅ |
| A9 | Malformed | 200 bytes without `\n` (limit 100) | Fatal "Frame too large" | ✅ |
| A10 | Concurrency | alice, bob and carol connected; group message plus DM | All 3 receive group msg; only carol gets the DM | ✅ |
| A11 | Reconnect | erin quits and rejoins with the same name while dave stays connected | dave sees `left (quit)`, `joined`, then erin's new message | ✅ |
| A12 | Abrupt close | grace's socket sends RST | frank sees `left (connection_reset)` | ✅ |
| A13 | Malformed / validation | Non-JSON, message before hello, name "x", blank text, unknown type, duplicate "HEIDI" | Correct error codes; server still works afterwards | ✅ |
| A14 | Framing over real TCP | Write 7 bytes, pause 50 ms, then write the rest of frame 1 plus all of frame 2 together | "one", then "two" | ✅ |

## B. Manual local tests (`127.0.0.1:5000`)

| ID | Test | Steps | Expected | Actual | Result |
|---|---|---|---|---|---|
| B1 | Two users chat | Start server; clients `ola`, `bob`; exchange messages both ways | Both see both messages with `#seq` | Verified 25 Nov during development: ola ↔ bob, `#1`, `#2` | ✅ |
| B2 | Graceful quit | bob types `/quit` | ola sees `* bob left (quit)`; log shows `peer_fin_received` then `reason:"quit"` | Verified 25 Nov | ✅ |
| B3 | Abrupt quit | ola types `/crash` | Log shows `socket_error ECONNRESET` then `reason:"connection_reset"` | Verified 25 Nov | ✅ |
| B4 | Duplicate username | Connect a second `BOB` while `bob` is online | `username_taken`; client exits | Verified 25 Nov | ✅ |
| B5 | Raw netcat input | `nc 127.0.0.1 5000`, type `hello there` (not JSON) | `error malformed`; server keeps running | `[FILL]` | ⏳ |
| B6 | Netcat valid JSON | Type `{"type":"hello","username":"nc"}`, then `{"type":"msg","text":"hi"}` | Other clients see `nc: hi` | `[FILL]` | ⏳ |
| B7 | 10-error limit | Send 10 bad lines via nc | `too_many_errors`, then the connection closes | `[FILL]` | ⏳ |
| B8 | Server shutdown | Ctrl+C on the server with 2 clients connected | Clients see `server_shutdown`, then FIN received | `[FILL]` | ⏳ |
| B9 | Port change | `TCP_PORT=6000 npm run tcp:server`; client `--port 6000` | Connects on 6000; port 5000 refused | `[FILL]` | ⏳ |
| B10 | Server not running | Run the client with no server | `Connection error: ECONNREFUSED` (an RST answers the SYN) | `[FILL]` | ⏳ |

## C. Cloud tests (`[FILL: EXTERNAL-IP]:5000`)

| ID | Test | Steps | Expected | Actual | Result |
|---|---|---|---|---|---|
| C1 | Reachability | `Test-NetConnection <IP> -Port 5000` (Windows) or `nc -vz <IP> 5000` | TcpTestSucceeded: True | `[FILL]` | ⏳ |
| C2 | Two users, two networks | Laptop on Wi-Fi + second device on mobile data | Messages both ways | `[FILL]` | ⏳ |
| C3 | Three simultaneous clients | Add a third client | All 3 receive broadcasts; `/users` lists 3 | `[FILL]` | ⏳ |
| C4 | Reconnect | One client `/quit`s, then rejoins while the others stay | Others see `left`, then `joined`; history shown on rejoin | `[FILL]` | ⏳ |
| C5 | Abrupt client kill | Close the terminal window / kill the process | Others see `left (connection_reset)` or `(closed)` | `[FILL]` | ⏳ |
| C6 | Silent failure | Turn off Wi-Fi on one client and wait | Removed after keep-alive or idle timeout (note the time taken) | `[FILL]` | ⏳ |
| C7 | Firewall: blocked port | `Test-NetConnection <IP> -Port 8080` | Fails (blocked) | `[FILL]` | ⏳ |
| C8 | Firewall: SSH restricted | SSH from a different network (e.g. phone hotspot) | Times out | `[FILL]` | ⏳ |
| C9 | Restart resilience | `sudo systemctl restart veil-tcp-chat`; also `sudo kill -9 <pid>` | Service back within about 2 s (`Restart=on-failure`) | `[FILL]` | ⏳ |
| C10 | Reboot | `sudo reboot`, wait, then connect | Service started automatically | `[FILL]` | ⏳ |

## D. Experiment and comparison runs

| ID | Run | Output file | Done |
|---|---|---|---|
| D1 | Exp 1 handshake capture | `captures/exp1-handshake.pcap` | ⏳ |
| D2 | Exp 2 loss capture + bench | `captures/exp2-loss.pcap`, `results/exp2-loss10-bench.json` | ⏳ |
| D3 | Exp 3 termination capture | `captures/exp3-termination.pcap` | ⏳ |
| D4 | Exp 4 bench A/B(/C) + capture | `results/A-loopback-bench.json`, `results/B-internet-bench.json`, `captures/exp4-perf.pcap` | ⏳ |
| D5 | TCP vs UDP comparison | `results/RESULTS.md` + JSON/CSV | ⏳ |

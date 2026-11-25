# VEIL TCP Chat (transport-layer assignment module)

A multi-user chat over **raw TCP sockets** using Node.js's built-in `net` module.
It has no dependencies and needs no secrets. It lives next to the VEIL web API, but runs
as a separate process on its own port.

| File | Purpose |
|---|---|
| `server.js` | TCP chat server: tracks connections, group and DM routing, validation, logs, FIN/RST handling |
| `client.js` | Command-line client |
| `protocol.js` | NDJSON framing (`FrameDecoder`) and validation |
| `PROTOCOL.md` | Message format specification |
| `tests/` | Framing unit tests and server integration tests |
| `logs/server.log` | Connection and error log (created at runtime, not committed) |

## Requirements

Node.js 18 or newer (tested on Node 22). Nothing to install.

## Run locally

From the repository root, start the server:

```bash
npm run tcp:server
```

Then open a terminal for each user:

```bash
node tcp-chat/client.js --host 127.0.0.1 --port 5000 --name ola
```

```bash
node tcp-chat/client.js --host 127.0.0.1 --port 5000 --name bob
```

Client commands: type text to message everyone. `/dm <user> <text>` sends a private
message, `/users` lists who is online, `/ping` measures RTT, `/quit` disconnects cleanly
(FIN) and `/crash` disconnects abruptly (RST).

To change the listening port (useful if your lecturer asks for it live):

```bash
TCP_PORT=6000 npm run tcp:server
```

You can also connect without the client, using netcat. Type JSON lines by hand:

```bash
nc 127.0.0.1 5000
```

```
{"type":"hello","username":"netcat"}
{"type":"msg","text":"typed by hand"}
```

## Tests

```bash
npm run tcp:test
```

The tests cover:
- frames split across reads, combined in one read, sent one byte at a time, and with emoji split mid-character
- three clients connected at once
- a client reconnecting while others stay connected
- an abrupt RST being detected
- malformed JSON, invalid usernames and messages, and duplicate names

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TCP_HOST` | `0.0.0.0` | Interface to bind to |
| `TCP_PORT` | `5000` | Port to listen on |
| `TCP_IDLE_TIMEOUT_MS` | `300000` | Disconnect clients idle this long |
| `TCP_LOG_FILE` | `tcp-chat/logs/server.log` | Log file path |

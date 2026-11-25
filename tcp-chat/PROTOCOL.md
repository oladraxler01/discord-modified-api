# VEIL TCP Chat Protocol (v1)

## Transport

- **TCP**, default port **5000** (set with the `TCP_PORT` environment variable).
- One TCP connection per client. The server tells connections apart by their
  4-tuple: client IP, client port (an ephemeral port picked by the OS), server IP and server port.
- No TLS in v1, so payloads are visible in Wireshark (see the report for why and what this limits).

## Framing: newline-delimited JSON (NDJSON)

TCP is a byte stream with no message boundaries, so a frame is:

```
<one JSON object encoded as UTF-8, with no raw newlines inside> \n
```

`JSON.stringify` escapes any newline inside a string as `\n`, so a real byte `0x0A` can
only mean "end of frame". The receiver adds every incoming chunk to a buffer, cuts it at
each `\n` and parses each complete line. Any partial bytes left over wait for the next
chunk (see `FrameDecoder` in `protocol.js`).

- Maximum frame size: 16 KiB. A longer line without a newline closes the connection.
- `\r\n` is accepted, so you can test by hand with `nc` or `telnet`.
- Blank lines are ignored.
- Invalid JSON, or JSON that isn't an object, gets an `error` reply. After 10 errors the connection is closed.

## Client → server messages

| type | fields | meaning |
|---|---|---|
| `hello` | `username` (2–20 chars, `[A-Za-z0-9_-]`, unique ignoring case) | Identify yourself. Must come first. |
| `msg` | `text` (1–1000 chars after trimming) | Message to the group room |
| `dm` | `to`, `text` | Private one-to-one message |
| `list` | – | Ask for the list of online users |
| `ping` | `t` (any value, echoed back) | Measure RTT |
| `bye` | – | Disconnect cleanly. The server replies `bye` and then sends FIN |

## Server → client messages

| type | fields |
|---|---|
| `welcome` | `username`, `connectionId`, `client {ip,port}`, `server {ip,port}`, `users[]`, `history[]` (last 20 `msg`) |
| `msg` | `seq` (server-wide order number), `from`, `text`, `ts` (ms since epoch) |
| `dm` | `from`, `to`, `text`, `ts` |
| `joined` | `username`, `ts` |
| `left` | `username`, `reason`: `quit` \| `closed` \| `connection_reset` \| `timeout` \| `error:<code>`, `ts` |
| `users` | `users[]` |
| `pong` | `t` (echoed), `serverTs` |
| `bye` | – |
| `error` | `code`, `message` |

Error codes: `malformed`, `not_identified`, `already_identified`, `invalid_username`,
`username_taken`, `invalid_text`, `unknown_user`, `unknown_type`, `too_many_errors`,
`idle_timeout`, `server_shutdown`, `server_error`.

## Example session

```
C→S {"type":"hello","username":"ola"}\n
S→C {"type":"welcome","username":"ola","connectionId":3,"client":{"ip":"41.x.x.x","port":51234},"server":{"ip":"10.128.0.2","port":5000},"users":["bob","ola"],"history":[]}\n
C→S {"type":"msg","text":"hi"}\n
S→C {"type":"msg","seq":1,"from":"ola","text":"hi","ts":1764107000000}\n
C→S {"type":"bye"}\n
S→C {"type":"bye"}\n          (then TCP FIN/ACK in both directions)
```

## Connection lifecycle (server side)

| Event | TCP meaning | Server action |
|---|---|---|
| `connection` | Three-way handshake finished (SYN, SYN-ACK, ACK) | Register the client and log the peer IP:port |
| `end` | The peer sent **FIN** (normal close) | Close our side too. Reason `closed` or `quit` |
| `error` `ECONNRESET` | The peer sent **RST** (crash or kill) | Reason `connection_reset` |
| `timeout` | No data for 5 minutes | Send an error, then FIN |
| keep-alive | OS probes after 30 s idle | Finds peers that vanished without sending FIN or RST |
| `close` | Socket fully closed | Remove the client and broadcast `left` |

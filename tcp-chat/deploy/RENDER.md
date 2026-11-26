# Deploying the TCP chat on Render (WebSocket gateway)

Render web services expose **one public HTTPS port** and do not accept raw TCP from the
Internet. So `tcp-chat/gateway.js` runs both parts in one service:

```
Browser / CLI --WSS (TLS over TCP 443)--> Render edge proxy --HTTP/WS over TCP--> gateway.js ($PORT)
                                              gateway.js --raw TCP, NDJSON--> server.js (127.0.0.1:5000)
```

Each WebSocket user gets its own raw TCP connection to the chat server. The TCP server code,
the framing, validation and FIN/RST handling are the same as in local testing.

## Create the service (about 5 minutes)

1. https://dashboard.render.com → **New +** → **Web Service** → **Build and deploy from a Git repository**.
2. Choose the repository **discord-modified-api**.
3. Settings:

   | Field | Value |
   |---|---|
   | Name | `veil-tcp-chat` |
   | Branch | `claude/jolly-davinci-db5797` |
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `node tcp-chat/gateway.js` |
   | Instance Type | **Free** |
   | Health Check Path (Advanced) | `/health` |

   No environment variables are needed. Render sets `PORT` automatically, and the chat
   needs no secrets.
4. Click **Create Web Service** and wait for **Live** (2–4 minutes).
5. Open `https://veil-tcp-chat.onrender.com` (your URL is shown at the top of the dashboard).

## Use it

- **Browser:** open the URL on two devices or browsers, enter different names, and chat.
- **CLI client:**

  ```bash
  node tcp-chat/client.js --url wss://veil-tcp-chat.onrender.com/ws --name ola
  ```

## Operate

| Action | How |
|---|---|
| Logs | Dashboard → service → **Logs** (`gateway_open`, `connection_open`, `connection_closed` …) |
| Restart | **Manual Deploy → Restart service** (SIGTERM → graceful shutdown) |
| Update | push to the branch; auto-deploy rebuilds |
| Stop / cleanup | **Settings → Suspend** or **Delete Web Service** |

## Limits (state them in the report)

- **Free tier:** no card needed, $0. The service **sleeps after about 15 minutes idle**, and the first visit then takes up to about a minute to wake it. Open the URL a minute before your demo.
- **TLS** is terminated at Render's edge (HTTPS/WSS). Traffic between the edge and the
  container, and the gateway → chat-server hop on 127.0.0.1, are not encrypted.
- **No raw-TCP access from outside**, and no firewall rules to configure: Render only exposes
  443 (and 80 → redirect). You can't run tcpdump/Wireshark on Render, so packet captures come from local experiments.
- In-memory state is lost on restart or sleep.

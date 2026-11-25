# TCP investigations: step-by-step guide

**Where to run:** on your cloud VM (Ubuntu), over SSH. You run the client from your laptop
and open the `.pcap` files in Wireshark on your laptop. Only impair (`tc netem`) networks you
own. **Always run `sudo ./tcp-chat/experiments/netem.sh clear` afterwards.**

One-time setup on the VM:

```bash
sudo apt-get update && sudo apt-get install -y tcpdump iproute2
```

If `netem.sh` says `Specified qdisc kind is unknown`, the cloud kernel is missing the netem module. Install it and load it:

```bash
sudo apt-get install -y linux-modules-extra-$(uname -r) && sudo modprobe sch_netem
```

To copy a capture to your laptop (run this on your laptop; the folder is created when the first capture runs):

```bash
scp -r <user>@<VM-IP>:~/discord-modified-api/tcp-chat/experiments/captures .
```

On GCP you can use `gcloud compute scp` instead. Do **not** type real passwords or private
messages while capturing: the chat is plaintext and everything shows up in the capture.

Useful Wireshark filters: `tcp.port == 5000`, `tcp.flags.syn == 1`,
`tcp.analysis.retransmission`, `tcp.flags.reset == 1`, `tcp.flags.fin == 1`.
To read the JSON, right-click a packet → Follow → TCP Stream.
Turn off relative sequence numbers (Edit → Preferences → Protocols → TCP) when you want to
quote the real Initial Sequence Number (ISN).

---

## Experiment 1: Connection establishment (three-way handshake)

1. In VM terminal A, start the server:

   ```bash
   npm run tcp:server
   ```

2. In VM terminal B, start the capture:

   ```bash
   sudo ./tcp-chat/experiments/capture.sh exp1-handshake "tcp port 5000"
   ```

3. On your laptop, connect, send `hello`, then `/quit`:

   ```bash
   node tcp-chat/client.js --host <VM-IP> --port 5000 --name ola
   ```

4. Press Ctrl+C in terminal B and download `exp1-handshake.pcap`.

**Screenshot and annotate:**
- the first 3 packets: `[SYN]`, `[SYN, ACK]`, `[ACK]`
- client IP and ephemeral port (e.g. 51234), and server IP and port 5000
- the SYN's sequence number = client ISN *x*
- SYN-ACK: seq = server ISN *y*, ack = *x*+1
- final ACK: seq = *x*+1, ack = *y*+1
- the TCP options in the SYN: MSS, Window Scale, SACK permitted

**Note for the report:** on the VM the server sees its *internal* IP (e.g. `10.128.0.2`), and
the client address is your router's public IP. That's NAT: the cloud provider maps
the VM's external IP to its internal one. Compare this with the `client`/`server` fields in
the `welcome` message and with the server log line `connection_open`.

## Experiment 2: Packet loss and retransmission

To keep it controlled, run it all on the VM over loopback (`lo`). This doesn't affect your SSH session.

1. Terminal A:

   ```bash
   npm run tcp:server
   ```

2. Terminal B:

   ```bash
   sudo ./tcp-chat/experiments/capture.sh exp2-loss "tcp port 5000" lo
   ```

3. Terminal C, add 10% loss, then run a load:

   ```bash
   sudo ./tcp-chat/experiments/netem.sh loss 10
   ```

   ```bash
   node tcp-chat/bench.js --host 127.0.0.1 --port 5000 --label exp2-loss10 --pings 100 --messages 300
   ```

   Then remove the loss:

   ```bash
   sudo ./tcp-chat/experiments/netem.sh clear
   ```

4. Stop the capture. In Wireshark, apply the filter `tcp.analysis.retransmission || tcp.analysis.duplicate_ack || tcp.analysis.fast_retransmission`.

**What to explain:** retransmitted segments carry the *same* sequence number. Duplicate ACKs
mean the receiver is asking for the missing byte again. Fast retransmit happens after 3 duplicate ACKs, and
timeout retransmission after the RTO (Linux minimum is about 200 ms). Look at the bench output:
the RTT `max`/`p95` jumps (around 200 ms or more) but **every** message still arrives, in order.
That is TCP's reliability, and the delay is its cost. You can also chart
Statistics → TCP Stream Graphs → Stevens to see the stalls.

## Experiment 3: Connection termination, normal vs abrupt

1. Terminal A:

   ```bash
   npm run tcp:server
   ```

2. Terminal B:

   ```bash
   sudo ./tcp-chat/experiments/capture.sh exp3-termination "tcp port 5000"
   ```

3. Laptop window 1: connect, then type `/quit`. This is the normal close (FIN).

   ```bash
   node tcp-chat/client.js --host <VM-IP> --name normal
   ```

4. Laptop window 2: connect, then type `/crash`. This is the abrupt close (RST). You could also kill the process from Task Manager, which closes it abruptly.

   ```bash
   node tcp-chat/client.js --host <VM-IP> --name abrupt
   ```

5. Stop the capture. Then save the server log:

   ```bash
   grep -E "fin|reset|closed" tcp-chat/logs/server.log | tail
   ```

**Compare:**
- **Normal:** `bye` frame → `[FIN, ACK]` from one side → `ACK` → `[FIN, ACK]` from the other → `ACK`.
  Server log: `peer_fin_received`, then `connection_closed reason=quit`. Other users see `left (quit)`.
- **Abrupt:** a single `[RST]` (or `[RST, ACK]`) with no FIN exchange. Server log:
  `socket_error code=ECONNRESET`, then `connection_closed reason=connection_reset`.
- **Server cleanup** (`server.js`, the `close` handler) does the same thing in both cases:
  remove the client from the map and broadcast `left`.
- **Optional third case:** if the laptop simply loses its network, there is no FIN and no RST.
  The server only finds out through TCP keep-alive or the idle timeout. This is what
  TCP *cannot* tell you instantly.

## Experiment 4: Flow control and performance (two conditions)

**Condition A, local (loopback on the VM):**

```bash
node tcp-chat/bench.js --host 127.0.0.1 --port 5000 --label A-loopback
```

**Condition B, over the internet (laptop to cloud VM):**

```bash
node tcp-chat/bench.js --host <VM-IP> --port 5000 --label B-internet
```

**Optional condition C, emulated slow link on loopback:**

```bash
sudo ./tcp-chat/experiments/netem.sh delay 100
```

```bash
node tcp-chat/bench.js --host 127.0.0.1 --port 5000 --label C-delay100
```

```bash
sudo ./tcp-chat/experiments/netem.sh clear
```

Capture during B:

```bash
sudo ./tcp-chat/experiments/capture.sh exp4-perf "tcp port 5000"
```

While B is running, look at the kernel's view of the connection on the VM:

```bash
ss -tin 'sport = :5000'
```

The output shows `rtt`, `cwnd`, `rcv_space`, `snd_wnd` and so on.

**Receive window (rwnd):** in Wireshark, add the column `tcp.window_size` (the calculated
window = Window × 2^scale from the SYN). Chart it with Statistics → TCP Stream Graphs → Window Scaling.
Explain that this is the receiver telling the sender how much buffer space it has free (flow control).
On a fast link with small chat messages the window rarely fills, so the throughput limit is RTT
(you have to wait for replies), not rwnd. Show the RTT difference between A and B.

Put the numbers into the report table:

```bash
node tcp-chat/compare/summarize.js
```

This writes `tcp-chat/compare/results/RESULTS.md`.

---

## TCP vs UDP comparison (separate tool, at least 100 numbered messages)

Run everything automatically on the VM (baseline, then 10% loss):

```bash
./tcp-chat/compare/run-all.sh
```

You can also capture it at the same time in another terminal:

```bash
sudo ./tcp-chat/experiments/capture.sh compare "port 6001 or port 6002" lo
```

To run it by hand (for example laptop → VM, with UDP 6001 and TCP 6002 opened in the firewall),
start the receivers on the VM:

```bash
node tcp-chat/compare/receiver.js --proto udp --port 6001 --label manual
```

```bash
node tcp-chat/compare/receiver.js --proto tcp --port 6002 --label manual
```

Then run the senders on your laptop:

```bash
node tcp-chat/compare/sender.js --proto udp --host <VM-IP> --port 6001 --count 100 --label manual
```

```bash
node tcp-chat/compare/sender.js --proto tcp --host <VM-IP> --port 6002 --count 100 --label manual
```

**Expected pattern under loss:** UDP received is about 90 out of 100, with gaps in `missing`, no
retransmission, low and steady RTT, and it could even arrive out of order. TCP received is 100 out
of 100 and in order, but RTT max/p95 is higher because of retransmission waits.

**What the results do not prove:** loopback and netem are an emulation (random, independent loss),
not real congestion. 100 messages is a small sample (repeat 3 times if you have time). One-way latency
is only valid on one machine. On loopback a UDP reorder is very unlikely, so "no reordering seen"
doesn't mean UDP guarantees order.

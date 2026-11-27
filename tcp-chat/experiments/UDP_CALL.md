# Live UDP voice call (WebRTC) — how it works and how to capture it

- **Signalling over TCP:** offer / answer / ICE candidates / hangup are `{"type":"call",...}` frames relayed by `server.js` (logged as `call_signal`).
- **Voice over UDP:** after ICE, audio (Opus in SRTP/RTP) flows **directly between the two devices over UDP**, not through Render.
- The call panel shows live `RTCPeerConnection.getStats()`: transport (UDP), local/remote IP:port, packets sent/received/**lost**, loss %, jitter, RTT, bitrate, codec.
- UDP has no retransmission: lost voice packets are **not resent**, and the codec conceals the gap. TCP would have to wait and resend, which a live call can't afford.

## Capture in Wireshark
1. Put both devices on the same Wi-Fi/hotspot. Capture on **Wi-Fi**.
2. Filter: `udp && !dns && !mdns && !ssdp`. The large, steady stream (~50 packets/s each way) is the voice.
3. Make Wireshark decode it: **Analyze → Enabled Protocols → search `rtp_udp` → tick**. Packets then show as **STUN** (connectivity checks), **DTLS** (key exchange) and **RTP/SRTP** (voice).
4. **Telephony → RTP → RTP Streams** shows each direction with **Lost**, **Max Jitter** and **Packets**.
5. Loss test (local, two browser tabs): clumsy filter `udp and outbound`, Drop 10% → "Packets lost" rises in the call panel, the audio glitches, and nothing is retransmitted.

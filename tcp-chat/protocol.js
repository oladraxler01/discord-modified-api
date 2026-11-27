// Application-layer protocol for the TCP chat: newline-delimited JSON (NDJSON).
//
// TCP delivers an ordered BYTE STREAM, not messages. One socket 'data' event may
// contain half a message, exactly one, or several glued together. Each message is
// therefore one JSON object followed by "\n" (the frame delimiter). FrameDecoder
// buffers incoming bytes and only emits a message once its "\n" has arrived.
import { StringDecoder } from "string_decoder";

export const DELIMITER = "\n";
export const MAX_FRAME_BYTES = 512 * 1024; // reject absurdly long lines (memory safety); voice notes fit inside

export const encode = (message) => JSON.stringify(message) + DELIMITER;

export class FrameDecoder {
  constructor({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
    // StringDecoder keeps a multi-byte UTF-8 character (e.g. an emoji) intact
    // even when TCP splits its bytes across two reads.
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.maxFrameBytes = maxFrameBytes;
  }

  // Feed raw bytes from socket 'data'. Returns an array of results, each either
  // { message } (parsed JSON object) or { error, raw } (malformed frame).
  push(chunk) {
    this.buffer += this.decoder.write(chunk);
    const results = [];
    let index;
    while ((index = this.buffer.indexOf(DELIMITER)) !== -1) {
      const raw = this.buffer.slice(0, index).replace(/\r$/, ""); // tolerate CRLF (telnet/netcat)
      this.buffer = this.buffer.slice(index + 1);
      if (!raw.trim()) continue; // ignore blank lines
      try {
        const message = JSON.parse(raw);
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          results.push({ error: "Frame must be a JSON object.", raw });
        } else {
          results.push({ message });
        }
      } catch {
        results.push({ error: "Invalid JSON.", raw });
      }
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
      this.buffer = "";
      results.push({ error: "Frame too large.", fatal: true });
    }
    return results;
  }
}

export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{2,20}$/;
export const MAX_TEXT_LENGTH = 1000;

export const validateUsername = (username) => {
  if (typeof username !== "string") return "Username must be a string.";
  if (!USERNAME_PATTERN.test(username)) {
    return "Username must be 2-20 characters: letters, digits, _ or -.";
  }
  return null;
};

export const validateText = (text) => {
  if (typeof text !== "string") return "Text must be a string.";
  const trimmed = text.trim();
  if (!trimmed) return "Text must not be empty.";
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return `Text must be at most ${MAX_TEXT_LENGTH} characters.`;
  }
  return null;
};

// Voice notes travel as one NDJSON frame: base64 data URL of the recorded audio.
export const MAX_VOICE_CHARS = 400 * 1024; // ~300 KB of audio (about 60 s of Opus)
export const validateVoice = (msg) => {
  if (typeof msg.data !== "string" || !/^data:audio\/[\w.+-]+(;[\w=.+-]+)*;base64,[A-Za-z0-9+/=]+$/.test(msg.data)) {
    return "Voice data must be a base64 audio data URL.";
  }
  if (msg.data.length > MAX_VOICE_CHARS) return "Voice note is too long (max about 60 s).";
  const d = Number(msg.duration);
  if (!Number.isFinite(d) || d <= 0 || d > 120) return "Voice duration must be 0-120 seconds.";
  return null;
};

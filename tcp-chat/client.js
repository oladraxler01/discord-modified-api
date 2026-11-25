// Command-line TCP chat client.
//
//   node tcp-chat/client.js --host 34.12.34.56 --port 5000 --name ola
//
// Commands:  plain text = group message
//            /dm <user> <text>   private message
//            /users              list connected users
//            /ping               measure round-trip time (RTT)
//            /quit               graceful disconnect (TCP FIN)
//            /crash              abrupt disconnect (TCP RST) for Experiment 3
import net from "net";
import readline from "readline";
import { encode, FrameDecoder } from "./protocol.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const host = arg("host", process.env.TCP_HOST || "127.0.0.1");
const port = Number(arg("port", process.env.TCP_PORT || 5000));
const username = arg("name", process.env.USER_NAME || `user${Math.floor(Math.random() * 1000)}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
const print = (line) => {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(line);
  rl.prompt(true);
};
const time = (ts) => new Date(ts).toLocaleTimeString();

const decoder = new FrameDecoder();
const socket = net.createConnection({ host, port });
socket.setNoDelay(true);

let identified = false;
let quitting = false;
const pending = []; // lines typed before the server accepted our username

const sendFrame = (message) => {
  if (!socket.destroyed && socket.writable) socket.write(encode(message));
};
const quit = () => {
  if (quitting) return;
  quitting = true;
  if (identified) sendFrame({ type: "bye" });
  else socket.end(); // not joined yet: just close (FIN)
};

socket.on("connect", () => {
  print(
    `Connected (TCP) ${socket.localAddress}:${socket.localPort} -> ${socket.remoteAddress}:${socket.remotePort}`,
  );
  sendFrame({ type: "hello", username });
});

socket.on("data", (chunk) => {
  for (const { message, error } of decoder.push(chunk)) {
    if (error) {
      print(`! bad frame from server: ${error}`);
      continue;
    }
    switch (message.type) {
      case "welcome":
        identified = true;
        print(`Welcome ${message.username}. Online: ${message.users.join(", ")}`);
        for (const m of message.history) print(`  [${time(m.ts)}] ${m.from}: ${m.text}`);
        pending.splice(0).forEach(handleLine);
        break;
      case "msg":
        print(`[${time(message.ts)}] #${message.seq} ${message.from}: ${message.text}`);
        break;
      case "dm":
        print(`[${time(message.ts)}] (DM ${message.from} -> ${message.to}) ${message.text}`);
        break;
      case "joined":
        print(`* ${message.username} joined`);
        break;
      case "left":
        print(`* ${message.username} left (${message.reason})`);
        break;
      case "users":
        print(`Online: ${message.users.join(", ")}`);
        break;
      case "pong":
        print(`RTT ${(Number(process.hrtime.bigint() - BigInt(message.t)) / 1e6).toFixed(2)} ms`);
        break;
      case "error":
        print(`! ${message.code}: ${message.message}`);
        if (!identified && ["username_taken", "invalid_username"].includes(message.code)) {
          print("Choose another name with --name. Exiting.");
          socket.end();
        }
        break;
      case "bye":
        break;
      default:
        print(`? ${JSON.stringify(message)}`);
    }
  }
});

socket.on("end", () => print("Server closed the connection (FIN received)."));
socket.on("error", (e) => print(`Connection error: ${e.code || e.message}`));
socket.on("close", () => {
  print("Disconnected.");
  process.exit(0);
});

const handleLine = (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (!identified && text !== "/crash" && text !== "/quit") {
    pending.push(text);
    return undefined;
  }
  if (text === "/quit") {
    quit();
  } else if (text === "/crash") {
    socket.resetAndDestroy(); // sends RST instead of FIN
  } else if (text === "/users") {
    sendFrame({ type: "list" });
  } else if (text === "/ping") {
    sendFrame({ type: "ping", t: process.hrtime.bigint().toString() });
  } else if (text.startsWith("/dm ")) {
    const [, to, ...rest] = text.split(" ");
    sendFrame({ type: "dm", to, text: rest.join(" ") });
  } else {
    sendFrame({ type: "msg", text });
  }
  return rl.prompt();
};

rl.on("line", handleLine);
rl.on("close", quit); // Ctrl+D
process.on("SIGINT", quit); // Ctrl+C = polite quit

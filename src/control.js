// Local control channel between actions/CLI and the daemon: newline-delimited
// JSON over a unix socket in the plugin state dir. One request per connection.
import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";

/** `handler(message)` resolves with a response object (sent back as JSON). */
export function listenControl(socketPath, handler) {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      let response;
      try {
        response = await handler(JSON.parse(line));
      } catch (error) {
        response = { ok: false, error: error.message };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** Sends one control message; rejects with the socket error when the daemon is down. */
export function sendControl(socketPath, message, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error("scheduler daemon did not respond");
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      const error = new Error("scheduler daemon closed the connection");
      error.code = "ECONNRESET";
      finish(error);
    });
  });
}

export async function controlAlive(socketPath) {
  try {
    const response = await sendControl(socketPath, { cmd: "ping" }, { timeoutMs: 1500 });
    return response.ok === true;
  } catch {
    return false;
  }
}

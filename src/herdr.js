// Talking to Herdr: the raw socket for module.* (no CLI wrapper exists) and
// liveness pings; the CLI at HERDR_BIN_PATH for workspace/agent/tab/pane work.
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";

export class HerdrError extends Error {
  constructor(code, message) {
    super(code ? `${code}: ${message}` : message);
    this.code = code;
  }
}

let requestCounter = 0;

/**
 * Sends one newline-delimited JSON request over the Herdr socket and resolves
 * with `result`. Rejects with HerdrError for API errors, or the raw socket
 * error (code ENOENT, ECONNREFUSED, ...) when the server is unreachable.
 */
export function socketRequest(socketPath, method, params = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `schedule-tasks:${process.pid}:${++requestCounter}`;
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
      const error = new Error(`${method} timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        finish(new HerdrError("invalid_response", error.message));
        return;
      }
      if (response.error) finish(new HerdrError(response.error.code, response.error.message ?? "request failed"));
      else finish(null, response.result);
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      const error = new Error(`connection closed before ${method} responded`);
      error.code = "ECONNRESET";
      finish(error);
    });
  });
}

/**
 * Runs `herdr <args...>` and resolves with the parsed JSON `result`, or
 * `undefined` for commands such as `pane run` that print nothing on success.
 */
export function runHerdr(args, { bin = process.env.HERDR_BIN_PATH || "herdr", timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(cliError(args, error, stderr));
        return;
      }
      if (stdout.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(stdout).result);
      } catch {
        reject(new HerdrError("invalid_response", `herdr ${args[0]} ${args[1] ?? ""} printed non-JSON output`));
      }
    });
  });
}

function cliError(args, error, stderr) {
  const text = (stderr ?? "").trim();
  try {
    const parsed = JSON.parse(text.split("\n").pop());
    if (parsed.error) return new HerdrError(parsed.error.code, parsed.error.message ?? "request failed");
  } catch {
    // Not a JSON error envelope: fall through to the raw text.
  }
  if (error.code === "ENOENT") return new HerdrError("herdr_not_found", `cannot run ${error.path}`);
  if (error.killed) return new HerdrError("timeout", `herdr ${args.slice(0, 2).join(" ")} timed out`);
  return new HerdrError(null, text || error.message);
}

function findOne(candidates, describe, what) {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new HerdrError("target_not_found", `${what} not found`);
  throw new HerdrError("target_ambiguous", `${what} is ambiguous (${candidates.map(describe).join(", ")})`);
}

/** Picks the workspace whose label (exactly, then case-insensitively) or id matches. */
export function resolveWorkspace(workspaces, wanted) {
  const exact = workspaces.filter((ws) => ws.label === wanted);
  const loose = exact.length > 0 ? exact : workspaces.filter((ws) => ws.label?.toLowerCase() === wanted.toLowerCase());
  const byId = loose.length > 0 ? loose : workspaces.filter((ws) => ws.workspace_id === wanted);
  return findOne(byId, (ws) => ws.workspace_id, `workspace "${wanted}"`);
}

/**
 * Picks the agent pane in `workspaceId` whose user-assigned name matches, or
 * else whose agent kind (`claude`, `codex`, ...) matches. Case-insensitive.
 */
export function resolveAgentPane(agents, workspaceId, wanted) {
  const needle = wanted.toLowerCase();
  const local = agents.filter((agent) => agent.workspace_id === workspaceId);
  const byName = local.filter((agent) => agent.name?.toLowerCase() === needle);
  const candidates =
    byName.length > 0
      ? byName
      : local.filter((agent) => agent.agent?.toLowerCase() === needle || agent.display_agent?.toLowerCase() === needle);
  return findOne(candidates, (agent) => agent.pane_id, `agent "${wanted}" in workspace ${workspaceId}`).pane_id;
}

export function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}

/**
 * Executes one validated task. `herdr` is the CLI runner (injectable for
 * tests). Resolves with a short description; rejects with the failure.
 */
export async function executeTask(task, herdr = runHerdr) {
  if (task.kind === "prompt") {
    let paneId = task.pane_id;
    if (paneId === undefined) {
      const [{ workspaces }, { agents }] = await Promise.all([herdr(["workspace", "list"]), herdr(["agent", "list"])]);
      const workspace = resolveWorkspace(workspaces ?? [], task.workspace);
      paneId = resolveAgentPane(agents ?? [], workspace.workspace_id, task.agent);
    }
    // `agent prompt` types the text and submits it with Enter.
    await herdr(["agent", "prompt", paneId, task.text]);
    return `prompted ${paneId}`;
  }
  const { workspaces } = await herdr(["workspace", "list"]);
  const workspace = resolveWorkspace(workspaces ?? [], task.workspace);
  const args = ["tab", "create", "--workspace", workspace.workspace_id, "--no-focus"];
  if (task.cwd !== undefined) args.push("--cwd", expandHome(task.cwd));
  if (task.tab_name !== undefined) args.push("--label", task.tab_name);
  const created = await herdr(args);
  const paneId = created?.root_pane?.pane_id;
  if (!paneId) throw new HerdrError("invalid_response", "tab create returned no root pane");
  // `pane run` sends the command text followed by Enter.
  await herdr(["pane", "run", paneId, task.command]);
  return `started in ${paneId}`;
}

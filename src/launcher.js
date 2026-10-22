// Starting, finding, and stopping the single daemon instance.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, statSync } from "node:fs";

import { controlAlive, sendControl } from "./control.js";
import { controlSocketPath, DAEMON_SCRIPT, logFile, pidFile, PLUGIN_ROOT } from "./paths.js";

const MAX_LOG_BYTES = 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readPid(stateDir) {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(stateDir), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * True when `pid` is alive and runs a schedule-tasks daemon script (guards pid
 * reuse). Matches any installation path, since updates move the plugin root.
 */
export function isDaemonPid(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    // Gone, or EPERM (another user's process): not our daemon either way.
    return false;
  }
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return command.includes("/src/daemon.js");
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

function rotateLog(file) {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
}

function spawnDaemon(stateDir, env) {
  const log = logFile(stateDir);
  rotateLog(log);
  const fd = openSync(log, "a");
  try {
    const child = spawn(process.execPath, [DAEMON_SCRIPT], {
      cwd: PLUGIN_ROOT,
      detached: true,
      env,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
}

/** Starts the daemon unless it already answers. Resolves "running" or "started". */
export async function ensureDaemon(stateDir, env = process.env, { timeoutMs = 5000 } = {}) {
  const socket = controlSocketPath(stateDir);
  if (await controlAlive(socket)) return "running";
  spawnDaemon(stateDir, env);
  if (!(await waitUntil(() => controlAlive(socket), timeoutMs))) {
    throw new Error(`scheduler daemon did not start; see ${logFile(stateDir)}`);
  }
  return "started";
}

/** Stops the daemon. Resolves "stopped" or "not-running". */
export async function stopDaemon(stateDir, { timeoutMs = 5000 } = {}) {
  const socket = controlSocketPath(stateDir);
  const pid = readPid(stateDir);
  if (await controlAlive(socket)) {
    await sendControl(socket, { cmd: "stop" }).catch(() => undefined);
  } else if (isDaemonPid(pid)) {
    process.kill(pid, "SIGTERM");
  } else {
    return "not-running";
  }
  const gone = await waitUntil(async () => !isDaemonPid(pid) && !(await controlAlive(socket)), timeoutMs);
  if (!gone) {
    if (isDaemonPid(pid)) process.kill(pid, "SIGKILL");
    else throw new Error("scheduler daemon did not stop");
  }
  return "stopped";
}

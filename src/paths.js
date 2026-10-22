import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_ID } from "./module.js";

export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DAEMON_SCRIPT = join(PLUGIN_ROOT, "src", "daemon.js");

// Written by the daemon/actions so `bin/schedule` can find the state dir
// outside Herdr (`herdr plugin config-dir` only prints the config dir).
const STATE_POINTER = ".state-dir";
// sockaddr_un.sun_path is 104 bytes on macOS, 108 on Linux.
const MAX_SOCKET_PATH_BYTES = 100;

/** Plugin dirs from Herdr's runtime env, or null outside a plugin command. */
export function pluginDirsFromEnv(env = process.env) {
  if (env.HERDR_PLUGIN_ID !== PLUGIN_ID || !env.HERDR_PLUGIN_CONFIG_DIR || !env.HERDR_PLUGIN_STATE_DIR) return null;
  return { configDir: env.HERDR_PLUGIN_CONFIG_DIR, stateDir: env.HERDR_PLUGIN_STATE_DIR };
}

/** Item id from a sidebar click: HERDR_MODULE_ITEM_ID, else the invocation context. */
export function clickedItemId(env = process.env) {
  if (env.HERDR_MODULE_ITEM_ID) return env.HERDR_MODULE_ITEM_ID;
  try {
    const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}");
    return typeof context?.module_item_id === "string" && context.module_item_id !== "" ? context.module_item_id : undefined;
  } catch {
    return undefined;
  }
}

export function tasksFile(configDir) {
  return join(configDir, "tasks.json");
}

export function stateFile(stateDir) {
  return join(stateDir, "state.json");
}

export function pidFile(stateDir) {
  return join(stateDir, "daemon.pid");
}

export function logFile(stateDir) {
  return join(stateDir, "daemon.log");
}

export function controlSocketPath(stateDir) {
  const preferred = join(stateDir, "ctl.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  const digest = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  return join(tmpdir(), `herdr-schedule-${digest}.sock`);
}

export function writeStatePointer(configDir, stateDir) {
  const file = join(configDir, STATE_POINTER);
  try {
    if (readFileSync(file, "utf8").trim() === stateDir) return;
  } catch {
    // Missing pointer: write it below.
  }
  writeFileAtomic(file, `${stateDir}\n`);
}

export function readStatePointer(configDir) {
  try {
    const value = readFileSync(join(configDir, STATE_POINTER), "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Write-then-rename so readers never observe a partial file. */
export function writeFileAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}

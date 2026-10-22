// Long-running scheduler. Single instance per state dir; the only writer of
// state.json. Started detached by the startup hook or by an action.
import { existsSync, openSync, closeSync, readFileSync, statSync, unlinkSync, watch, writeSync } from "node:fs";

import { listenControl, controlAlive } from "./control.js";
import { executeTask, focusTask, socketRequest } from "./herdr.js";
import { isDaemonPid, readPid } from "./launcher.js";
import { buildModule, buildStoppedModule } from "./module.js";
import {
  controlSocketPath,
  pidFile,
  pluginDirsFromEnv,
  stateFile,
  tasksFile,
  writeFileAtomic,
  writeStatePointer,
} from "./paths.js";
import { emptyState, evaluateDue, finishRun, reconcile, setEnabled, skipSlot, startRun } from "./scheduler.js";
import { emptyTasksFile, parseTasksFile } from "./tasks.js";

const TICK_MS = 10_000;
const HEAL_PUBLISH_MS = 60_000;
const MAX_PING_FAILURES = 3;
const EXIT_ON_PUBLISH_ERRORS = new Set(["plugin_disabled", "plugin_not_found"]);

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

class Daemon {
  constructor(dirs, herdrSocket) {
    this.dirs = dirs;
    this.herdrSocket = herdrSocket;
    this.controlPath = controlSocketPath(dirs.stateDir);
    this.tasksPath = tasksFile(dirs.configDir);
    this.statePath = stateFile(dirs.stateDir);
    this.entries = [];
    this.configError = undefined;
    this.tasksStamp = undefined;
    this.state = emptyState();
    this.savedState = "";
    this.running = new Set();
    this.stoppedByUser = false;
    this.stopping = false;
    this.pingFailures = 0;
    this.publishChain = Promise.resolve();
    this.published = { json: "", at: 0, failed: true, error: undefined };
  }

  // ---- lifecycle ---------------------------------------------------------

  async start() {
    if (!(await this.acquireLock())) {
      log("another scheduler daemon is running; exiting");
      return false;
    }
    log(`started (pid ${process.pid})`);
    writeStatePointer(this.dirs.configDir, this.dirs.stateDir);
    this.loadState();
    if (!existsSync(this.tasksPath)) writeFileAtomic(this.tasksPath, emptyTasksFile());
    this.reloadTasks(true);
    this.server = await listenControl(this.controlPath, (message) => this.handleControl(message));
    this.watchConfig();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(signal, () => this.shutdown(`received ${signal}`));
    }
    await this.publish(true);
    this.scheduleTick(0);
    return true;
  }

  async acquireLock() {
    const path = pidFile(this.dirs.stateDir);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, `${process.pid}\n`);
        closeSync(fd);
        return true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      if (isDaemonPid(readPid(this.dirs.stateDir)) || (await controlAlive(this.controlPath))) return false;
      unlinkSync(path);
    }
    return false;
  }

  releaseLock() {
    if (readPid(this.dirs.stateDir) !== process.pid) return;
    try {
      unlinkSync(pidFile(this.dirs.stateDir));
    } catch {
      // Already gone.
    }
  }

  async shutdown(reason, code = 0) {
    if (this.stopping) return;
    this.stopping = true;
    log(`stopping: ${reason}`);
    clearTimeout(this.tickTimer);
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.server?.close();
    try {
      unlinkSync(this.controlPath);
    } catch {
      // Already gone.
    }
    for (const entry of Object.values(this.state.tasks)) {
      if (entry.running) finishRun(entry, "interrupted: scheduler stopped");
    }
    this.saveState();
    this.releaseLock();
    process.exit(code);
  }

  // ---- persistence -------------------------------------------------------

  loadState() {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (parsed && typeof parsed.tasks === "object" && parsed.tasks !== null) this.state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") log(`state.json unreadable, starting fresh: ${error.message}`);
    }
    for (const entry of Object.values(this.state.tasks)) {
      if (entry.running) finishRun(entry, "interrupted: scheduler restarted");
    }
  }

  saveState() {
    const json = `${JSON.stringify(this.state, null, 2)}\n`;
    if (json === this.savedState) return;
    try {
      writeFileAtomic(this.statePath, json);
      this.savedState = json;
    } catch (error) {
      log(`cannot write state.json: ${error.message}`);
    }
  }

  // ---- tasks.json --------------------------------------------------------

  watchConfig() {
    try {
      this.watcher = watch(this.dirs.configDir, (_event, filename) => {
        if (filename && filename !== "tasks.json") return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          if (this.reloadTasks(false)) this.afterChange();
        }, 250);
      });
      this.watcher.on("error", (error) => log(`config watcher failed, relying on polling: ${error.message}`));
    } catch (error) {
      log(`cannot watch config dir, relying on polling: ${error.message}`);
    }
  }

  /** Re-reads tasks.json when it changed (or `force`). Returns true when anything changed. */
  reloadTasks(force) {
    let stamp;
    try {
      const stat = statSync(this.tasksPath);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      stamp = error.code === "ENOENT" ? "missing" : `error:${error.message}`;
    }
    if (!force && stamp === this.tasksStamp) return false;
    this.tasksStamp = stamp;
    const now = Date.now();
    try {
      const text = stamp === "missing" ? emptyTasksFile() : readFileSync(this.tasksPath, "utf8");
      this.entries = parseTasksFile(text, now);
      this.configError = undefined;
      const invalid = this.entries.filter((entry) => !entry.ok).length;
      log(`loaded ${this.entries.length} task(s)${invalid > 0 ? `, ${invalid} invalid` : ""}`);
    } catch (error) {
      // Keep the last good task list running while the file is being fixed.
      this.configError = error.message;
      log(`tasks.json rejected: ${error.message}`);
    }
    reconcile(this.state, this.entries, now);
    return true;
  }

  findTask(id) {
    return this.entries.find((entry) => entry.ok && entry.task.id === id)?.task;
  }

  // ---- scheduling --------------------------------------------------------

  scheduleTick(delay) {
    if (this.stopping) return;
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this.tick()
        .catch((error) => log(`tick failed: ${error.stack ?? error.message}`))
        .finally(() => {
          // Wake shortly after each minute boundary so runs start on time.
          const toNextMinute = 60_000 - (Date.now() % 60_000) + 250;
          this.scheduleTick(Math.min(TICK_MS, toNextMinute));
        });
    }, delay);
  }

  async tick() {
    if (!(await this.checkHerdr())) return;
    this.reloadTasks(false);
    if (!this.stoppedByUser) {
      const now = Date.now();
      for (const entry of this.entries) {
        if (!entry.ok) continue;
        const task = entry.task;
        const runtime = this.state.tasks[task.id];
        if (!runtime?.enabled) continue;
        const verdict = evaluateDue(task.cron, runtime.last_slot, now);
        if (!verdict.due) continue;
        if (this.running.has(task.id)) {
          skipSlot(runtime, now);
          log(`${task.id}: slot skipped, previous run still in flight`);
          continue;
        }
        this.launch(task, runtime, now, { missed: verdict.missed });
      }
    }
    this.afterChange();
  }

  async checkHerdr() {
    try {
      await socketRequest(this.herdrSocket, "ping", {}, { timeoutMs: 3000 });
    } catch (error) {
      this.pingFailures += 1;
      log(`herdr ping failed (${this.pingFailures}/${MAX_PING_FAILURES}): ${error.message}`);
      if (this.pingFailures >= MAX_PING_FAILURES) await this.shutdown("herdr socket is gone");
      return false;
    }
    if (this.pingFailures > 0) {
      // The server may have restarted or handed off: modules are transient.
      this.pingFailures = 0;
      this.published.failed = true;
    }
    return true;
  }

  launch(task, runtime, now, options) {
    startRun(runtime, now, options);
    this.running.add(task.id);
    log(`${task.id}: running${options.manual ? " (manual)" : ""}${options.missed ? ` after ${options.missed} missed slot(s)` : ""}`);
    this.afterChange();
    executeTask(task, undefined, { focus: options.focus === true })
      .then(
        (result) => {
          finishRun(runtime, undefined);
          // Remembered so clicking the task row can jump back to this run.
          runtime.last_tab_id = result.tab_id;
          runtime.last_pane_id = result.pane_id;
          log(`${task.id}: ok, ${result.summary}`);
        },
        (error) => {
          finishRun(runtime, error);
          log(`${task.id}: failed: ${error.message}`);
        },
      )
      .finally(() => {
        this.running.delete(task.id);
        this.afterChange();
      });
  }

  afterChange() {
    if (this.stopping) return;
    this.saveState();
    this.publish(false);
  }

  // ---- module publishing -------------------------------------------------

  publish(force) {
    this.publishChain = this.publishChain.then(() => this.publishNow(force));
    return this.publishChain;
  }

  async publishNow(force) {
    if (this.stopping && !this.stoppedByUser) return;
    const now = Date.now();
    const params = this.stoppedByUser
      ? buildStoppedModule()
      : buildModule({ entries: this.entries, state: this.state, configError: this.configError, now });
    const json = JSON.stringify(params);
    const fresh = now - this.published.at < HEAL_PUBLISH_MS;
    if (!force && !this.published.failed && json === this.published.json && fresh) return;
    try {
      await socketRequest(this.herdrSocket, "module.set", params);
      if (this.published.error) log("module.set recovered");
      this.published = { json, at: now, failed: false, error: undefined };
    } catch (error) {
      if (EXIT_ON_PUBLISH_ERRORS.has(error.code)) {
        await this.shutdown(`module.set: ${error.message}`);
        return;
      }
      if (this.published.error !== error.message) log(`module.set failed: ${error.message}`);
      this.published = { ...this.published, failed: true, error: error.message };
    }
  }

  // ---- control channel ---------------------------------------------------

  async handleControl(message) {
    const now = Date.now();
    switch (message?.cmd) {
      case "ping":
        return { ok: true, pid: process.pid };
      case "republish":
        await this.publish(true);
        return { ok: true };
      case "reload":
        this.reloadTasks(true);
        this.afterChange();
        return { ok: true };
      case "run": {
        this.reloadTasks(false);
        const task = this.findTask(message.task_id);
        if (!task) return { ok: false, error: `unknown or invalid task "${message.task_id}"` };
        if (this.running.has(task.id)) return { ok: false, error: `${task.id} is already running` };
        this.launch(task, this.state.tasks[task.id], now, { manual: true, focus: message.focus === true });
        return { ok: true };
      }
      case "open": {
        this.reloadTasks(false);
        const task = this.findTask(message.task_id);
        if (!task) return { ok: false, error: `unknown or invalid task "${message.task_id}"` };
        try {
          return { ok: true, focused: await focusTask(task, this.state.tasks[task.id] ?? {}) };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      }
      case "toggle":
      case "set-enabled": {
        this.reloadTasks(false);
        const task = this.findTask(message.task_id);
        if (!task) return { ok: false, error: `unknown or invalid task "${message.task_id}"` };
        const runtime = this.state.tasks[task.id];
        const enabled = message.cmd === "toggle" ? !runtime.enabled : message.enabled === true;
        setEnabled(runtime, enabled, now);
        log(`${task.id}: ${enabled ? "enabled" : "paused"}`);
        this.afterChange();
        return { ok: true, enabled };
      }
      case "stop":
        this.stoppedByUser = true;
        setTimeout(async () => {
          await this.publish(true);
          await this.shutdown("stop requested");
        }, 0);
        return { ok: true };
      default:
        return { ok: false, error: `unknown command ${JSON.stringify(message?.cmd)}` };
    }
  }
}

async function main() {
  const dirs = pluginDirsFromEnv();
  const herdrSocket = process.env.HERDR_SOCKET_PATH;
  if (!dirs || !herdrSocket) {
    console.error("schedule-tasks daemon must be started by Herdr (plugin env missing)");
    process.exit(2);
  }
  const daemon = new Daemon(dirs, herdrSocket);
  process.on("uncaughtException", (error) => {
    log(`uncaught: ${error.stack ?? error.message}`);
    daemon.shutdown("uncaught exception", 1);
  });
  process.on("unhandledRejection", (error) => {
    log(`unhandled rejection: ${error?.stack ?? error}`);
  });
  if (!(await daemon.start())) process.exit(0);
}

main();

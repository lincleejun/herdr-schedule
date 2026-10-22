// Pure scheduling decisions over the runtime state stored in state.json.
//
// Per-task state entry:
//   enabled         effective enabled flag (toggle action / CLI)
//   config_enabled  tasks.json "enabled" value last reconciled; a change in
//                   the file overrides the runtime flag
//   cron            expression the slot bookkeeping belongs to
//   last_slot       ms; every cron slot at or before this is handled
//   last_run_at     ms of the latest run start
//   last_result     "ok" | "error" | undefined
//   last_error      message of the latest failure
//   last_note       e.g. "missed 3" when a catch-up run collapsed missed slots
//   running         true while a run is in flight
import { minuteFloor, nextRun, parseCron } from "./cron.js";

export const MISSED_CAP = 100;

export function emptyState() {
  return { version: 1, tasks: {} };
}

/** Returns a fresh entry for a task first seen at `now` (no back-fire). */
export function newEntry(task, now) {
  return {
    enabled: task.enabled,
    config_enabled: task.enabled,
    cron: task.cron,
    last_slot: now,
    running: false,
  };
}

/**
 * Aligns `state` with the current task list. `entries` is the parseTasksFile
 * result; ids absent from it are pruned. Mutates and returns `state`.
 */
export function reconcile(state, entries, now) {
  const present = new Set();
  for (const entry of entries) {
    if (entry.ok) present.add(entry.task.id);
    else if (entry.id !== undefined) present.add(entry.id);
  }
  for (const id of Object.keys(state.tasks)) {
    if (!present.has(id)) delete state.tasks[id];
  }
  for (const entry of entries) {
    if (!entry.ok) continue;
    const task = entry.task;
    const current = state.tasks[task.id];
    if (!current) {
      state.tasks[task.id] = newEntry(task, now);
      continue;
    }
    if (current.config_enabled !== task.enabled) {
      current.config_enabled = task.enabled;
      setEnabled(current, task.enabled, now);
    }
    if (current.cron !== task.cron) {
      current.cron = task.cron;
      current.last_slot = now;
    }
  }
  return state;
}

/** Changes the runtime enabled flag; re-enabling never catches up paused slots. */
export function setEnabled(entry, enabled, now) {
  if (enabled && !entry.enabled) entry.last_slot = now;
  entry.enabled = enabled;
  return entry;
}

/**
 * Decides whether a task is due at `now`.
 * Returns { due: false, next } or { due: true, missed, next } where `missed`
 * counts earlier slots collapsed into this single run (capped at MISSED_CAP)
 * and `next` is the following slot after `now` (ms or null).
 */
export function evaluateDue(cronText, lastSlot, now) {
  const cron = parseCron(cronText);
  const first = nextRun(cron, lastSlot);
  if (first === null || first.getTime() > now) {
    return { due: false, next: first === null ? null : first.getTime() };
  }
  let missed = 0;
  let cursor = first;
  while (missed < MISSED_CAP) {
    const following = nextRun(cron, cursor);
    if (following === null || following.getTime() > now) break;
    missed += 1;
    cursor = following;
  }
  const next = nextRun(cron, Math.max(cursor.getTime(), minuteFloor(now)));
  return { due: true, missed, next: next === null ? null : next.getTime() };
}

/** Next slot strictly after `now`, for display. */
export function upcoming(cronText, now) {
  const next = nextRun(parseCron(cronText), now);
  return next === null ? null : next.getTime();
}

/**
 * Marks a run as started. `missed` comes from evaluateDue for scheduled
 * runs; manual runs pass `{ manual: true }` and keep the slot bookkeeping.
 */
export function startRun(entry, now, { missed = 0, manual = false } = {}) {
  if (!manual) entry.last_slot = Math.max(entry.last_slot ?? 0, minuteFloor(now));
  entry.running = true;
  entry.last_run_at = now;
  entry.last_note = missed > 0 ? `missed ${missed >= MISSED_CAP ? `${MISSED_CAP}+` : missed}` : undefined;
  return entry;
}

export function finishRun(entry, error) {
  entry.running = false;
  if (error === undefined || error === null) {
    entry.last_result = "ok";
    entry.last_error = undefined;
  } else {
    entry.last_result = "error";
    entry.last_error = String(error instanceof Error ? error.message : error);
  }
  return entry;
}

/** Records a skipped slot (task still running from an earlier slot). */
export function skipSlot(entry, now) {
  entry.last_slot = Math.max(entry.last_slot ?? 0, minuteFloor(now));
  return entry;
}

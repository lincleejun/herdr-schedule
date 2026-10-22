// Builds the `module.set` params for the sidebar. Pure; times use local zone.
import { upcoming } from "./scheduler.js";

export const PLUGIN_ID = "schedule-tasks";
export const SOURCE = `plugin:${PLUGIN_ID}`;
export const MODULE_ID = "tasks";
export const TITLE = "schedules";

const MAX_ITEMS = 64;
const MAX_LABEL = 80;
const MAX_DETAIL = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Replaces control characters (rejected by Herdr) with spaces. */
export function sanitize(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

/** Truncates to `max` characters (code points), ending with an ellipsis. */
export function truncate(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

const pad = (value) => String(value).padStart(2, "0");

function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** `09:00` today, `Tue 09:00` within a week, else `10-28 09:00`. */
export function formatTime(ms, now) {
  const date = new Date(ms);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const dayDelta = Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);
  if (dayDelta === 0) return clock;
  if (Math.abs(dayDelta) < 7) return `${WEEKDAYS[date.getDay()]} ${clock}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function itemStatus(entry) {
  if (entry.running) return "active";
  if (!entry.enabled) return "paused";
  if (entry.last_result === "error") return "error";
  if (entry.last_result === "ok") return "ok";
  return "neutral";
}

function lastRunText(entry, now) {
  if (entry.last_run_at === undefined || entry.last_result === undefined) return undefined;
  const result = entry.last_result === "ok" ? "ok" : "failed";
  const note = entry.last_note ? ` (${entry.last_note})` : "";
  return `${result} ${formatTime(entry.last_run_at, now)}${note}`;
}

/** Compact detail line for one task (≤120 chars). */
export function taskDetail(task, entry, now) {
  const parts = [];
  if (entry.running) {
    parts.push(`running since ${formatTime(entry.last_run_at ?? now, now)}`);
  } else if (!entry.enabled) {
    parts.push("paused");
    const last = lastRunText(entry, now);
    if (last) parts.push(last);
  } else {
    const next = upcoming(task.cron, now);
    parts.push(next === null ? "no upcoming run" : `next ${formatTime(next, now)}`);
    if (entry.last_result === "error") {
      parts.push(`error: ${sanitize(entry.last_error ?? "failed")}`);
    } else {
      const last = lastRunText(entry, now);
      if (last) parts.push(last);
    }
  }
  return truncate(sanitize(parts.join(" · ")), MAX_DETAIL);
}

function taskItem(task, entry, now) {
  return {
    id: task.id,
    label: truncate(sanitize(task.name) || task.id, MAX_LABEL),
    detail: taskDetail(task, entry, now),
    status: itemStatus(entry),
    actions: [
      { action_id: "run-now", label: "▶" },
      { action_id: "toggle", label: entry.enabled ? "⏸" : "⏵" },
    ],
  };
}

function invalidItem(entry) {
  const label = sanitize(entry.name ?? entry.id ?? "") || `task #${entry.index + 1}`;
  return {
    id: `invalid-${entry.index}`,
    label: truncate(label, MAX_LABEL),
    detail: truncate(sanitize(`invalid: ${entry.error}`), MAX_DETAIL),
    status: "error",
    actions: [],
  };
}

function hintItem() {
  return {
    id: "hint",
    label: "no scheduled tasks",
    detail: `add one: bin/schedule add <id> --cron "0 9 * * 1-5" --prompt "…" --workspace <label> --agent <name>`,
    status: "neutral",
    actions: [],
  };
}

function moduleParams(items) {
  return { source: SOURCE, module_id: MODULE_ID, title: TITLE, order: 0, items };
}

/**
 * entries: parseTasksFile result (last good list); state: runtime state;
 * configError: message when the latest tasks.json read failed.
 */
export function buildModule({ entries, state, configError, now }) {
  const items = [];
  if (configError) {
    items.push({
      id: "config-error",
      label: "tasks.json",
      detail: truncate(sanitize(`error: ${configError}`), MAX_DETAIL),
      status: "error",
      actions: [],
    });
  }
  for (const entry of entries) {
    if (!entry.ok) {
      items.push(invalidItem(entry));
      continue;
    }
    const runtime = state.tasks[entry.task.id] ?? { enabled: entry.task.enabled, running: false };
    items.push(taskItem(entry.task, runtime, now));
  }
  if (items.length === 0) items.push(hintItem());
  if (items.length > MAX_ITEMS) {
    const hidden = items.length - (MAX_ITEMS - 1);
    items.length = MAX_ITEMS - 1;
    items.push({ id: "more", label: `+${hidden} more tasks`, detail: "see bin/schedule list", status: "neutral", actions: [] });
  }
  return moduleParams(items);
}

/** Published by an explicit `stop` so the sidebar offers a restart control. */
export function buildStoppedModule() {
  return moduleParams([
    {
      id: "daemon",
      label: "scheduler stopped",
      detail: "no tasks will run until restarted",
      status: "paused",
      actions: [{ action_id: "restart", label: "↻" }],
    },
  ]);
}

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildModule, buildStoppedModule, formatTime, sanitize, truncate } from "../src/module.js";
import { emptyState, reconcile } from "../src/scheduler.js";
import { parseTasksFile } from "../src/tasks.js";

// Monday 2026-01-05 08:30.
const NOW = new Date(2026, 0, 5, 8, 30).getTime();
const at = (d, h, mi) => new Date(2026, 0, d, h, mi).getTime();

function setup(tasks) {
  const entries = parseTasksFile(JSON.stringify({ tasks }), NOW);
  const state = reconcile(emptyState(), entries, NOW - 60_000);
  return { entries, state };
}

const standup = { id: "standup", name: "Standup", kind: "prompt", cron: "0 9 * * 1-5", text: "hi", pane_id: "w1:p1" };
const nightly = { id: "nightly", kind: "command", cron: "30 2 * * *", workspace: "api", command: "make" };

test("module envelope matches the module.set contract", () => {
  const { entries, state } = setup([standup]);
  const params = buildModule({ entries, state, now: NOW });
  assert.equal(params.source, "plugin:schedule-tasks");
  assert.equal(params.module_id, "tasks");
  assert.equal(params.title, "schedules");
  assert.equal(params.order, 0);
  assert.deepEqual(params.items, [
    {
      id: "standup",
      label: "Standup",
      detail: "next 09:00",
      status: "neutral",
      actions: [
        { action_id: "run-now", label: "▶" },
        { action_id: "toggle", label: "⏸" },
      ],
    },
  ]);
});

test("status and detail follow the runtime state", () => {
  const { entries, state } = setup([standup, nightly]);
  state.tasks.standup.last_run_at = at(5, 8, 0);
  state.tasks.standup.last_result = "ok";
  state.tasks.nightly.last_run_at = at(5, 2, 30);
  state.tasks.nightly.last_result = "error";
  state.tasks.nightly.last_error = "workspace \"api\" not found";
  let items = buildModule({ entries, state, now: NOW }).items;
  assert.equal(items[0].status, "ok");
  assert.equal(items[0].detail, "next 09:00 · ok 08:00");
  assert.equal(items[1].status, "error");
  assert.equal(items[1].detail, `next Tue 02:30 · error: workspace "api" not found`);

  state.tasks.standup.running = true;
  state.tasks.standup.last_run_at = at(5, 8, 29);
  state.tasks.nightly.enabled = false;
  items = buildModule({ entries, state, now: NOW }).items;
  assert.equal(items[0].status, "active");
  assert.equal(items[0].detail, "running since 08:29");
  assert.equal(items[1].status, "paused");
  assert.equal(items[1].detail, "paused · failed 02:30");
  assert.deepEqual(items[1].actions[1], { action_id: "toggle", label: "⏵" });
});

test("missed-run note is shown with the last result", () => {
  const { entries, state } = setup([standup]);
  Object.assign(state.tasks.standup, { last_run_at: at(2, 9, 0), last_result: "ok", last_note: "missed 3" });
  assert.equal(buildModule({ entries, state, now: NOW }).items[0].detail, "next 09:00 · ok Fri 09:00 (missed 3)");
});

test("long errors and labels are truncated and control characters removed", () => {
  const { entries, state } = setup([{ ...standup, name: `A\tlong\nname ${"x".repeat(100)}` }]);
  Object.assign(state.tasks.standup, { last_run_at: at(5, 8, 0), last_result: "error", last_error: `boom\u001b[31m ${"e".repeat(300)}` });
  const [item] = buildModule({ entries, state, now: NOW }).items;
  assert.equal(Array.from(item.label).length, 80);
  assert.ok(item.label.startsWith("A long name x"));
  assert.ok(item.label.endsWith("…"));
  assert.equal(Array.from(item.detail).length, 120);
  assert.ok(item.detail.startsWith("next 09:00 · error: boom [31m e"));
  assert.doesNotMatch(item.detail + item.label, /[\u0000-\u001f\u007f-\u009f]/);
});

test("empty task list publishes a neutral hint without actions", () => {
  const { entries, state } = setup([]);
  const { items } = buildModule({ entries, state, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "hint");
  assert.equal(items[0].status, "neutral");
  assert.deepEqual(items[0].actions, []);
  assert.match(items[0].detail, /bin\/schedule add/);
  assert.ok(Array.from(items[0].detail).length <= 120);
});

test("invalid tasks and config errors become error items without actions", () => {
  const { entries, state } = setup([standup, { id: "bad id", kind: "prompt" }, { ...standup, name: "dup" }]);
  const { items } = buildModule({ entries, state, configError: "tasks.json is not valid JSON: oops", now: NOW });
  assert.deepEqual(
    items.map((item) => [item.id, item.status, item.actions.length]),
    [
      ["config-error", "error", 0],
      ["standup", "neutral", 2],
      ["invalid-1", "error", 0],
      ["invalid-2", "error", 0],
    ],
  );
  assert.equal(items[2].label, "bad id");
  assert.match(items[2].detail, /^invalid: "id" must be/);
  assert.equal(items[3].label, "dup");
});

test("more than 64 tasks collapse into a final overflow item", () => {
  const tasks = Array.from({ length: 70 }, (_, i) => ({ ...nightly, id: `t${i}` }));
  const { entries, state } = setup(tasks);
  const { items } = buildModule({ entries, state, now: NOW });
  assert.equal(items.length, 64);
  assert.equal(items[63].id, "more");
  assert.equal(items[63].label, "+7 more tasks");
  assert.equal(new Set(items.map((item) => item.id)).size, 64);
});

test("item ids, labels, and action labels respect Herdr limits", () => {
  const { entries, state } = setup([standup, nightly]);
  for (const item of buildModule({ entries, state, now: NOW }).items) {
    assert.match(item.id, /^[A-Za-z0-9:._-]{1,64}$/);
    assert.ok(Array.from(item.label).length >= 1 && Array.from(item.label).length <= 80);
    assert.ok(item.actions.length <= 4);
    for (const action of item.actions) {
      assert.match(action.action_id, /^[A-Za-z0-9:_-]{1,64}$/);
      assert.ok(Array.from(action.label).length <= 12);
    }
  }
});

test("stopped module offers a restart control", () => {
  const { items } = buildStoppedModule();
  assert.deepEqual(items[0].actions, [{ action_id: "restart", label: "↻" }]);
  assert.equal(items[0].status, "paused");
});

test("formatTime is relative to now", () => {
  assert.equal(formatTime(at(5, 9, 5), NOW), "09:05");
  assert.equal(formatTime(at(6, 9, 0), NOW), "Tue 09:00");
  assert.equal(formatTime(at(2, 9, 0), NOW), "Fri 09:00");
  assert.equal(formatTime(at(20, 9, 0), NOW), "01-20 09:00");
});

test("truncate and sanitize helpers", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
  assert.equal(truncate("😀😀😀😀😀", 3), "😀😀…");
  assert.equal(sanitize(" a\r\nb\u0085c "), "a b c");
});

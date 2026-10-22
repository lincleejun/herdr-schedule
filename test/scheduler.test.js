process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyState,
  evaluateDue,
  finishRun,
  MISSED_CAP,
  reconcile,
  setEnabled,
  skipSlot,
  startRun,
} from "../src/scheduler.js";

const MIN = 60_000;
const at = (h, mi, s = 0, d = 5) => new Date(2026, 0, d, h, mi, s).getTime();
const okEntry = (task) => ({ ok: true, task });
const task = (overrides = {}) => ({ id: "t", name: "t", kind: "command", cron: "0 9 * * *", enabled: true, ...overrides });

test("not due before the slot, due once it arrives", () => {
  const lastSlot = at(8, 30);
  assert.deepEqual(evaluateDue("0 9 * * *", lastSlot, at(8, 59, 59)), { due: false, next: at(9, 0) });
  const verdict = evaluateDue("0 9 * * *", lastSlot, at(9, 0, 3));
  assert.equal(verdict.due, true);
  assert.equal(verdict.missed, 0);
  assert.equal(verdict.next, at(9, 0, 0, 6));
});

test("fires once per matching minute across repeated ticks", () => {
  const entry = { last_slot: at(8, 59, 30) };
  let fired = 0;
  for (let now = at(9, 0, 1); now < at(9, 3); now += 10_000) {
    if (evaluateDue("* * * * *", entry.last_slot, now).due) {
      fired += 1;
      startRun(entry, now);
      finishRun(entry);
    }
  }
  // Minutes 09:00, 09:01, 09:02 each fire exactly once.
  assert.equal(fired, 3);
});

test("a task first seen mid-slot does not back-fire", () => {
  const state = reconcile(emptyState(), [okEntry(task({ cron: "0 9 * * *" }))], at(9, 0, 20));
  assert.equal(evaluateDue("0 9 * * *", state.tasks.t.last_slot, at(9, 0, 40)).due, false);
});

test("missed runs after sleep collapse into one run with a note", () => {
  const entry = { last_slot: at(9, 0) };
  // Laptop slept from 09:00 to 13:05: slots 10:00..13:00 were missed.
  const now = at(13, 5);
  const verdict = evaluateDue("0 * * * *", entry.last_slot, now);
  assert.equal(verdict.due, true);
  assert.equal(verdict.missed, 3); // 10:00, 11:00, 12:00 skipped; 13:00 runs
  assert.equal(verdict.next, at(14, 0));
  startRun(entry, now, { missed: verdict.missed });
  assert.equal(entry.last_note, "missed 3");
  assert.equal(evaluateDue("0 * * * *", entry.last_slot, now + 5 * MIN).due, false);
});

test("a single missed slot runs once without a note", () => {
  const entry = { last_slot: at(8, 0) };
  const verdict = evaluateDue("0 9 * * *", entry.last_slot, at(14, 0));
  assert.equal(verdict.due, true);
  assert.equal(verdict.missed, 0);
  startRun(entry, at(14, 0), { missed: verdict.missed });
  assert.equal(entry.last_note, undefined);
});

test("missed count is capped", () => {
  const verdict = evaluateDue("* * * * *", at(0, 0, 0, 1), at(0, 0, 0, 5));
  assert.equal(verdict.missed, MISSED_CAP);
  const entry = { last_slot: at(0, 0, 0, 1) };
  startRun(entry, at(0, 0, 0, 5), { missed: verdict.missed });
  assert.equal(entry.last_note, `missed ${MISSED_CAP}+`);
  // Bookkeeping jumps to "now" even when the count was capped.
  assert.equal(evaluateDue("* * * * *", entry.last_slot, at(0, 0, 30, 5)).due, false);
});

test("manual runs keep the slot bookkeeping", () => {
  const entry = { last_slot: at(8, 0) };
  startRun(entry, at(8, 30), { manual: true });
  assert.equal(entry.last_slot, at(8, 0));
  assert.equal(entry.running, true);
  finishRun(entry, new Error("boom"));
  assert.equal(entry.running, false);
  assert.equal(entry.last_result, "error");
  assert.equal(entry.last_error, "boom");
  finishRun(entry);
  assert.equal(entry.last_result, "ok");
  assert.equal(entry.last_error, undefined);
});

test("skipSlot advances without running", () => {
  const entry = { last_slot: at(8, 0) };
  skipSlot(entry, at(9, 0, 10));
  assert.equal(evaluateDue("0 9 * * *", entry.last_slot, at(9, 0, 50)).due, false);
});

test("re-enabling does not catch up paused slots", () => {
  const entry = { enabled: true, last_slot: at(8, 0) };
  setEnabled(entry, false, at(8, 30));
  setEnabled(entry, true, at(12, 0));
  assert.equal(evaluateDue("0 * * * *", entry.last_slot, at(12, 0, 30)).due, false);
  assert.equal(evaluateDue("0 * * * *", entry.last_slot, at(13, 0, 5)).due, true);
});

test("reconcile adds, prunes, and follows tasks.json changes", () => {
  let state = reconcile(emptyState(), [okEntry(task({ id: "a" })), okEntry(task({ id: "b" }))], at(7, 0));
  assert.deepEqual(Object.keys(state.tasks).sort(), ["a", "b"]);

  // Runtime toggle survives a reload with unchanged file value.
  setEnabled(state.tasks.a, false, at(7, 5));
  state = reconcile(state, [okEntry(task({ id: "a" })), okEntry(task({ id: "b" }))], at(7, 10));
  assert.equal(state.tasks.a.enabled, false);

  // A changed file value wins.
  state = reconcile(state, [okEntry(task({ id: "a", enabled: false })), okEntry(task({ id: "b" }))], at(7, 15));
  assert.equal(state.tasks.a.enabled, false);
  state = reconcile(state, [okEntry(task({ id: "a", enabled: true })), okEntry(task({ id: "b" }))], at(7, 20));
  assert.equal(state.tasks.a.enabled, true);
  assert.equal(state.tasks.a.last_slot, at(7, 20));

  // Cron change resets the slot; invalid entries keep their state; removed ids are pruned.
  state = reconcile(
    state,
    [okEntry(task({ id: "a", cron: "*/5 * * * *" })), { ok: false, index: 1, id: "b", error: "bad" }],
    at(7, 30),
  );
  assert.equal(state.tasks.a.cron, "*/5 * * * *");
  assert.equal(state.tasks.a.last_slot, at(7, 30));
  assert.ok(state.tasks.b);
  state = reconcile(state, [okEntry(task({ id: "a", cron: "*/5 * * * *" }))], at(7, 40));
  assert.deepEqual(Object.keys(state.tasks), ["a"]);
});

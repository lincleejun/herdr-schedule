process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import { test } from "node:test";

import { nextRun, parseCron } from "../src/cron.js";
import { evaluateDue, startRun } from "../src/scheduler.js";

const HOUR = 3_600_000;
const next = (expr, from) => nextRun(parseCron(expr), from)?.getTime() ?? null;

test("spring-forward: nonexistent local times are skipped", () => {
  // 2026-03-08 02:00 EST jumps to 03:00 EDT.
  const before = new Date(2026, 2, 8, 1, 0).getTime();
  const found = new Date(next("30 2 * * *", before));
  assert.equal(found.getDate(), 9);
  assert.equal(found.getHours(), 2);
  assert.equal(found.getMinutes(), 30);
});

test("fall-back: a slot in the repeated hour fires once", () => {
  // 2026-11-01 01:00-01:59 occurs twice (EDT, then EST).
  const firstOneThirty = Date.parse("2026-11-01T01:30:00-04:00");
  assert.equal(next("30 1 * * *", Date.parse("2026-11-01T00:00:00-04:00")), firstOneThirty);
  const entry = { last_slot: 0 };
  startRun(entry, firstOneThirty + 5_000);
  // Second pass through 01:30 (EST) is an hour later: not due.
  const verdict = evaluateDue("30 1 * * *", entry.last_slot, firstOneThirty + HOUR + 5_000);
  assert.equal(verdict.due, false);
  assert.equal(new Date(verdict.next).getDate(), 2);
});

test("fall-back: nextRun never moves backwards from the repeated hour", () => {
  const secondPass = Date.parse("2026-11-01T01:45:00-05:00");
  for (const expr of ["* * * * *", "*/5 * * * *", "50 1 * * *", "0 2 * * *"]) {
    const found = next(expr, secondPass);
    assert.ok(found > secondPass, `${expr}: ${new Date(found).toISOString()}`);
  }
  assert.equal(next("* * * * *", secondPass), secondPass + 60_000);
});

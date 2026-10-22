process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { test } from "node:test";

import { CronError, cronMatches, nextRun, parseCron } from "../src/cron.js";

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const next = (expr, from) => nextRun(parseCron(expr), from)?.getTime() ?? null;
const sorted = (set) => [...set].sort((a, b) => a - b);

test("parses wildcards, lists, ranges, and steps", () => {
  const cron = parseCron("*/15 9-17/4 1,15 * *");
  assert.deepEqual(sorted(cron.minutes), [0, 15, 30, 45]);
  assert.deepEqual(sorted(cron.hours), [9, 13, 17]);
  assert.deepEqual(sorted(cron.days), [1, 15]);
  assert.equal(cron.months.size, 12);
  assert.equal(cron.weekdays.size, 7);
  assert.equal(cron.dayOfMonthRestricted, true);
  assert.equal(cron.dayOfWeekRestricted, false);
});

test("value with step runs to the end of the range", () => {
  assert.deepEqual(sorted(parseCron("50/5 * * * *").minutes), [50, 55]);
});

test("parses month and weekday names case-insensitively; 7 is Sunday", () => {
  const cron = parseCron("0 9 * JAN,mar-May sun,7,Fri");
  assert.deepEqual(sorted(cron.months), [1, 3, 4, 5]);
  assert.deepEqual(sorted(cron.weekdays), [0, 5]);
  assert.deepEqual(sorted(parseCron("0 0 * * mon-fri").weekdays), [1, 2, 3, 4, 5]);
});

test("normalizes whitespace in the source", () => {
  assert.equal(parseCron("  0   9 * *  1-5 ").source, "0 9 * * 1-5");
});

test("rejects malformed expressions with readable errors", () => {
  const cases = [
    ["", /expected 5 fields/],
    ["* * * *", /expected 5 fields/],
    ["* * * * * *", /expected 5 fields/],
    ["@daily", /expected 5 fields/],
    ["60 * * * *", /minute value 60 is outside 0-59/],
    ["* 24 * * *", /hour value 24/],
    ["* * 0 * *", /day-of-month value 0/],
    ["* * * 13 *", /month value 13/],
    ["* * * * 8", /day-of-week value 8/],
    ["*/0 * * * *", /step must be at least 1/],
    ["5-1 * * * *", /runs backwards/],
    ["1,,2 * * * *", /invalid minute term/],
    ["x * * * *", /invalid minute value "x"/],
    ["* * * foo *", /invalid month value/],
    ["1-2-3 * * * *", /invalid minute range/],
    ["*-5 * * * *", /invalid minute value/],
  ];
  for (const [expr, pattern] of cases) {
    assert.throws(() => parseCron(expr), (error) => error instanceof CronError && pattern.test(error.message), expr);
  }
});

test("cronMatches checks every field", () => {
  const cron = parseCron("30 9 * * 1-5");
  assert.equal(cronMatches(cron, at(2026, 1, 5, 9, 30)), true); // Monday
  assert.equal(cronMatches(cron, at(2026, 1, 4, 9, 30)), false); // Sunday
  assert.equal(cronMatches(cron, at(2026, 1, 5, 9, 31)), false);
});

test("day-of-month and day-of-week OR when both are restricted", () => {
  const cron = parseCron("0 0 13 * fri");
  assert.equal(cronMatches(cron, at(2026, 2, 13)), true); // Friday the 13th
  assert.equal(cronMatches(cron, at(2026, 1, 13)), true); // Tuesday the 13th
  assert.equal(cronMatches(cron, at(2026, 1, 2)), true); // a Friday
  assert.equal(cronMatches(cron, at(2026, 1, 14)), false);
});

test("a starred step keeps day fields AND-ed", () => {
  const cron = parseCron("0 0 */2 * mon");
  assert.equal(cronMatches(cron, at(2026, 1, 5)), true); // Monday, odd day
  assert.equal(cronMatches(cron, at(2026, 1, 12)), false); // Monday, even day
  assert.equal(cronMatches(cron, at(2026, 1, 7)), false); // Wednesday, odd day
});

test("nextRun is strictly after the reference minute", () => {
  assert.equal(next("* * * * *", at(2026, 1, 1, 10, 0)), at(2026, 1, 1, 10, 1));
  assert.equal(next("* * * * *", at(2026, 1, 1, 10, 0) + 59_999), at(2026, 1, 1, 10, 1));
  assert.equal(next("0 9 * * *", at(2026, 1, 1, 9, 0)), at(2026, 1, 2, 9, 0));
  assert.equal(next("0 9 * * *", at(2026, 1, 1, 8, 59) + 30_000), at(2026, 1, 1, 9, 0));
});

test("nextRun skips across hours, days, months, and years", () => {
  assert.equal(next("15 * * * *", at(2026, 1, 1, 10, 20)), at(2026, 1, 1, 11, 15));
  assert.equal(next("0 9 * * 1-5", at(2026, 1, 2, 10, 0)), at(2026, 1, 5, 9, 0)); // Fri -> Mon
  assert.equal(next("0 0 31 * *", at(2026, 2, 1)), at(2026, 3, 31));
  assert.equal(next("0 0 1 jan *", at(2026, 6, 1)), at(2027, 1, 1));
  assert.equal(next("59 23 31 12 *", at(2026, 12, 31, 23, 59)), at(2027, 12, 31, 23, 59));
});

test("nextRun finds leap days and gives up on impossible dates", () => {
  assert.equal(next("0 0 29 2 *", at(2026, 3, 1)), at(2028, 2, 29));
  assert.equal(next("0 0 30 2 *", at(2026, 1, 1)), null);
  assert.equal(next("0 0 31 4 *", at(2026, 1, 1)), null);
});

test("nextRun agrees with brute-force minute scanning", () => {
  const expressions = ["*/7 */5 * * *", "0 0 13 * fri", "5 4 * * sun", "0 22 * * 1-5", "1-3/2 0 1,15 */3 *"];
  for (const expr of expressions) {
    const cron = parseCron(expr);
    let cursor = at(2026, 1, 1);
    for (let i = 0; i < 20; i += 1) {
      let brute = cursor + 60_000;
      while (!cronMatches(cron, brute)) brute += 60_000;
      const found = nextRun(cron, cursor).getTime();
      assert.equal(found, brute, `${expr} after ${new Date(cursor).toISOString()}`);
      cursor = found;
    }
  }
});

// Five-field cron expressions (minute hour day-of-month month day-of-week),
// evaluated in the process's local time zone.

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

const MINUTE_MS = 60_000;
// Long enough to cover a Feb 29 schedule across a skipped century leap year.
const SEARCH_LIMIT_MS = 8 * 366 * 24 * 60 * MINUTE_MS;

export class CronError extends Error {}

function parseValue(text, field) {
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    if (value < field.min || value > field.max) {
      throw new CronError(`${field.name} value ${value} is outside ${field.min}-${field.max}`);
    }
    return value;
  }
  if (field.names) {
    const index = field.names.indexOf(text.toLowerCase());
    if (index !== -1) return index + field.nameBase;
  }
  throw new CronError(`invalid ${field.name} value "${text}"`);
}

function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(",")) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CronError(`invalid ${field.name} term "${part}"`);
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new CronError(`${field.name} step must be at least 1`);
    let start;
    let end;
    if (range === "*") {
      start = field.min;
      end = field.max;
    } else if (range.includes("-")) {
      const bounds = range.split("-");
      if (bounds.length !== 2) throw new CronError(`invalid ${field.name} range "${range}"`);
      start = parseValue(bounds[0], field);
      end = parseValue(bounds[1], field);
      if (start > end) throw new CronError(`${field.name} range "${range}" runs backwards`);
    } else {
      start = parseValue(range, field);
      // `5/15` means "from 5 to the end, every 15"; a bare value is just itself.
      end = stepText === undefined ? start : field.max;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** Parses a five-field cron expression; throws CronError with a readable message. */
export function parseCron(expression) {
  if (typeof expression !== "string") throw new CronError("cron expression must be a string");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") {
    throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts[0] === "" ? 0 : parts.length}`);
  }
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, FIELDS[index]));
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    source: parts.join(" "),
    minutes,
    hours,
    days,
    months,
    weekdays,
    // Classic cron: when both day fields are restricted, either may match.
    dayOfMonthRestricted: !parts[2].startsWith("*"),
    dayOfWeekRestricted: !parts[4].startsWith("*"),
  };
}

function dayMatches(cron, date) {
  const dom = cron.days.has(date.getDate());
  const dow = cron.weekdays.has(date.getDay());
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return dom || dow;
  return dom && dow;
}

/** True when the local minute containing `date` matches `cron`. */
export function cronMatches(cron, date) {
  const value = new Date(date);
  return (
    cron.minutes.has(value.getMinutes()) &&
    cron.hours.has(value.getHours()) &&
    cron.months.has(value.getMonth() + 1) &&
    dayMatches(cron, value)
  );
}

export function minuteFloor(ms) {
  return ms - (((ms % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
}

// Applies a local-time adjustment but never moves backwards: around a DST
// fall-back, local arithmetic can resolve to the earlier of two instants.
function forward(current, adjust) {
  const next = new Date(current);
  adjust(next);
  if (next.getTime() > current.getTime()) return next;
  return new Date(minuteFloor(current.getTime()) + MINUTE_MS);
}

/**
 * Returns the first matching minute strictly after `after` (ms or Date) as a
 * Date, or null when the expression never matches within the search window.
 * Local times skipped by a DST spring-forward never match; the repeated hour
 * of a fall-back is visited once.
 */
export function nextRun(cron, after) {
  const start = new Date(after).getTime();
  const limit = start + SEARCH_LIMIT_MS;
  let date = new Date(minuteFloor(start) + MINUTE_MS);
  while (date.getTime() <= limit) {
    if (!cron.months.has(date.getMonth() + 1)) {
      date = forward(date, (d) => {
        d.setMonth(d.getMonth() + 1, 1);
        d.setHours(0, 0, 0, 0);
      });
    } else if (!dayMatches(cron, date)) {
      date = forward(date, (d) => {
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
      });
    } else if (!cron.hours.has(date.getHours())) {
      date = forward(date, (d) => d.setHours(d.getHours() + 1, 0, 0, 0));
    } else if (!cron.minutes.has(date.getMinutes())) {
      date = forward(date, (d) => d.setMinutes(d.getMinutes() + 1, 0, 0));
    } else {
      return date;
    }
  }
  return null;
}

const test = require("node:test");
const assert = require("node:assert");
const { parseSendDate } = require("../lib/dates.js");

// New York is used for exact expectations because its DST rules are stable in the tz database.
const ny = { timezone: "America/New_York", defaultSendTime: "09:00" };

test("wall-clock time is read in the configured time zone", () => {
  assert.strictEqual(parseSendDate("2026-12-01 09:30", ny).toISOString(), "2026-12-01T14:30:00.000Z"); // EST
  assert.strictEqual(parseSendDate("2026-07-01T09:30", ny).toISOString(), "2026-07-01T13:30:00.000Z"); // EDT
});

test("a date alone uses defaultSendTime", () => {
  assert.strictEqual(parseSendDate("2026-12-01", ny).toISOString(), "2026-12-01T14:00:00.000Z");
});

test("an explicit offset or Z wins over the time zone", () => {
  assert.strictEqual(parseSendDate("2026-12-01T09:00:00Z", ny).toISOString(), "2026-12-01T09:00:00.000Z");
  assert.strictEqual(parseSendDate("2026-12-01 09:00 -08:00", ny).toISOString(), "2026-12-01T17:00:00.000Z");
});

test("DST transition days resolve to the right instant", () => {
  assert.strictEqual(parseSendDate("2026-03-08 10:00", ny).toISOString(), "2026-03-08T14:00:00.000Z"); // after spring-forward
  assert.strictEqual(parseSendDate("2026-11-01 10:00", ny).toISOString(), "2026-11-01T15:00:00.000Z"); // after fall-back
});

test("any zone round-trips to the same wall-clock time", () => {
  for (const timezone of ["America/Vancouver", "Europe/London", "Australia/Melbourne", "Asia/Kolkata"]) {
    const d = parseSendDate("2026-12-01 09:30", { timezone });
    const wall = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
    assert.strictEqual(wall.replace(",", ""), "2026-12-01 09:30", timezone);
  }
});

test("bad values throw a readable error", () => {
  assert.throws(() => parseSendDate("next tuesday", ny), /Can't read sendDate/);
  assert.throws(() => parseSendDate("2026-13-01", ny), /Can't read sendDate/);
  assert.throws(() => parseSendDate("2026-12-01", { timezone: "Mars/Olympus" }), /Unknown time zone/);
  assert.strictEqual(parseSendDate(undefined, ny), null);
});

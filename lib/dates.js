// Turns a front-matter sendDate into an exact moment in time.
//
// Accepted forms:
//   2026-12-01                  -> that date at `defaultSendTime`, in `timezone`
//   2026-12-01 09:30            -> wall-clock time in `timezone`
//   2026-12-01T09:30:00         -> same
//   2026-12-01T09:30:00-08:00   -> exact moment (offset or Z wins over `timezone`)

const PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Unknown time zone "${timezone}". Use an IANA name such as "America/Vancouver".`);
  }
}

// Milliseconds to add to UTC to get wall-clock time in `timezone` at `date`.
function offsetAt(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

function wallTimeToDate(y, mo, d, h, mi, s, timezone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = offsetAt(new Date(guess), timezone);
  let t = guess - first;
  const second = offsetAt(new Date(t), timezone);
  if (second !== first) t = guess - second;
  return new Date(t);
}

function parseSendDate(value, { timezone = "UTC", defaultSendTime = "09:00" } = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return isNaN(value) ? invalid(value) : value;

  const raw = String(value).trim();
  const m = raw.match(PATTERN);
  if (!m) return invalid(raw);

  let [, y, mo, d, h, mi, s, offset] = m;
  if (h === undefined) {
    const t = String(defaultSendTime).match(/^(\d{1,2}):(\d{2})$/);
    if (!t) throw new Error(`defaultSendTime must look like "09:00", got "${defaultSendTime}".`);
    [, h, mi] = t;
    s = "0";
  }
  const nums = [y, mo, d, h, mi, s || "0"].map(Number);
  if (nums[1] < 1 || nums[1] > 12 || nums[2] < 1 || nums[2] > 31 || nums[3] > 23 || nums[4] > 59 || nums[5] > 59) {
    return invalid(raw);
  }

  if (offset) {
    const iso = `${y}-${mo}-${d}T${String(h).padStart(2, "0")}:${mi}:${String(s || "0").padStart(2, "0")}${
      offset.toUpperCase() === "Z" ? "Z" : offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")
    }`;
    const date = new Date(iso);
    return isNaN(date) ? invalid(raw) : date;
  }

  assertTimezone(timezone);
  return wallTimeToDate(...nums, timezone);
}

function invalid(raw) {
  throw new Error(`Can't read sendDate "${raw}". Use a form like 2026-12-01 or 2026-12-01 09:30.`);
}

function formatInZone(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

module.exports = { parseSendDate, formatInZone, assertTimezone };

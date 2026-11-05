// A plan's usage limit in a failure message (SF-072): the Claude session's ("You've hit your 5-hour
// limit · resets 3am (Europe/Sofia)") or the Codex gate's ("You've hit your usage limit. Try again in
// 2 hours 13 minutes."), and when it resets. One function for every caller: the Implementer turn,
// the Claude review and the simplification pass pass source claude, the gate codex; only that
// source's pattern applies. Only the first line of the message is read, as the board's
// usageLimited does, so a limit phrase quoted deeper in a long failure never counts.

export type LimitProvider = 'claude' | 'codex';

export interface UsageLimit {
  provider: LimitProvider;
  // The reset as ISO UTC; null when the message gives none that parses.
  resets_at: string | null;
}

// The pattern of each source's usage-limit message.
const PATTERNS: Record<LimitProvider, RegExp> = {
  claude: /hit your .*limit/i,
  codex: /usage limit|rate limit/i,
};

// The month of "resets Nov 7, 3am", by its first three letters.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "resets 3am (Europe/Sofia)", "resets Nov 7, 3am (Europe/Sofia)", "resets 3:30pm", "resets 15:00".
const RESETS = /resets\s+(?:([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;
// "try again in 2 hours 13 minutes", "try again in 20s", "try again in 1h 5m".
const TRY_AGAIN = /try again in\s+((?:\d+(?:\.\d+)?\s*[a-z]+(?:\s*,\s*|\s+and\s+|\s+)?)+)/i;
// The units of "try again in <duration>", in ms.
const UNIT_MS: Array<[RegExp, number]> = [
  [/^(d|days?)$/, 86_400_000],
  [/^(h|hrs?|hours?)$/, 3_600_000],
  [/^(m|mins?|minutes?)$/, 60_000],
  [/^(s|secs?|seconds?)$/, 1_000],
  [/^(ms|milliseconds?)$/, 1],
];

// The usage limit the first line of text reports for source, or undefined when it reports none.
export function usageLimit(text: string, now: Date, source: LimitProvider): UsageLimit | undefined {
  const first = text.split('\n', 1)[0] ?? '';
  if (!PATTERNS[source].test(first)) {
    return undefined;
  }
  return { provider: source, resets_at: resetTime(first, now) };
}

// When the limit of a line resets, as ISO UTC, or null. "resets <time>": the next occurrence of
// that time after now in the named IANA zone; "resets <Mon D>, <time>": that date (next year when
// already past); "try again in <duration>": now plus the duration. No zone or an unknown one: the
// zone of this process (sf serve's).
export function resetTime(line: string, now: Date): string | null {
  const again = TRY_AGAIN.exec(line);
  if (again !== null) {
    const ms = durationMs(again[1]!);
    if (ms !== undefined) {
      return new Date(now.getTime() + ms).toISOString();
    }
  }
  const resets = RESETS.exec(line);
  if (resets === null) {
    return null;
  }
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = resets;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) {
    return null;
  }
  const zone = knownZone(zoneText?.trim());
  const today = zonedDate(now, zone);
  if (monthName !== undefined) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    const day = Number(dayText);
    if (month < 0 || day < 1 || day > 31) {
      return null;
    }
    let at = zonedInstant(zone, today.year, month, day, hour, minute);
    if (at <= now.getTime()) {
      at = zonedInstant(zone, today.year + 1, month, day, hour, minute);
    }
    return new Date(at).toISOString();
  }
  let at = zonedInstant(zone, today.year, today.month, today.day, hour, minute);
  if (at <= now.getTime()) {
    at = zonedInstant(zone, today.year, today.month, today.day + 1, hour, minute);
  }
  return new Date(at).toISOString();
}

// The milliseconds of "2 hours 13 minutes", "20s", "1h 5m"; undefined for a unit it does not know.
function durationMs(text: string): number | undefined {
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const factor = UNIT_MS.find(([pattern]) => pattern.test(unit!.toLowerCase()))?.[1];
    if (factor === undefined) {
      return undefined;
    }
    total += Number(amount) * factor;
  }
  return total > 0 ? Math.round(total) : undefined;
}

// The zone when it is a known IANA zone, else this process's.
function knownZone(zone: string | undefined): string {
  if (zone !== undefined && zone !== '') {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      // An unknown zone: the process's.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// The wall-clock fields of an instant in a zone (month 0-based).
function zonedFields(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

// The calendar date of an instant in a zone (month 0-based).
function zonedDate(now: Date, zone: string): { year: number; month: number; day: number } {
  const { year, month, day } = zonedFields(now.getTime(), zone);
  return { year, month, day };
}

// The zone's offset from UTC at an instant, in ms.
function offsetAt(ms: number, zone: string): number {
  const f = zonedFields(ms, zone);
  return Date.UTC(f.year, f.month, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

// The instant of a wall-clock time in a zone (day may overflow the month: Date.UTC normalizes it).
function zonedInstant(zone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  let at = wall - offsetAt(wall, zone);
  // Once more at the found instant: the offset may differ across a DST change.
  at = wall - offsetAt(at, zone);
  return at;
}

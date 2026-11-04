// The local time of a stored timestamp (SF-049). The factory stores every time as ISO 8601 UTC
// (jobs.ts now()); what it prints for the user is the time of the zone the sf process runs in.
const pad = (value: number): string => String(value).padStart(2, '0');

// "YYYY-MM-DD HH:MM:SS" of a stored timestamp in local time; undefined when it is not a string
// that parses as a time.
export function localTime(ts: unknown): string | undefined {
  if (typeof ts !== 'string') {
    return undefined;
  }
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

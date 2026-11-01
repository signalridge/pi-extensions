/** Local calendar boundaries shared by collection and graph labels. */
const HOUR_MS = 3_600_000;

/** Reconstruct midnight for each intended date, without carrying a DST gap. */
export function civilDayStart(timestamp: number, dayOffset = 0): number {
  const local = new Date(timestamp);
  const midnight = new Date(local.getFullYear(), local.getMonth(), local.getDate() + dayOffset);
  // The multi-argument Date constructor treats years 0–99 as 1900–1999.
  if (local.getFullYear() < 100) midnight.setFullYear(local.getFullYear());
  return midnight.getTime();
}

/**
 * Midnight on the first of this local month. Built from the civil date, never by
 * subtracting days or milliseconds, so month length and any DST change earlier
 * in the month cannot shift it; a skipped midnight normalizes to that day's first instant.
 */
export function civilMonthStart(timestamp: number): number {
  const local = new Date(timestamp);
  const first = new Date(local.getFullYear(), local.getMonth(), 1);
  // The multi-argument Date constructor treats years 0–99 as 1900–1999.
  if (local.getFullYear() < 100) first.setFullYear(local.getFullYear());
  return first.getTime();
}

function minuteRemainder(timestamp: number): number {
  const local = new Date(timestamp);
  return (local.getMinutes() * 60 + local.getSeconds()) * 1000 + local.getMilliseconds();
}

/** First offset change in this at-most-one-hour interval, if any. */
function offsetTransition(start: number, end: number): number | undefined {
  const offset = new Date(start).getTimezoneOffset();
  if (new Date(end).getTimezoneOffset() === offset) return undefined;
  // A civil hour can be shortened or repeated by a non-hour DST transition.
  // Find the physical transition, rather than mapping a nonexistent :00 back
  // into a different civil hour. IANA transitions are isolated within an hour.
  let low = start;
  let high = end;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (new Date(mid).getTimezoneOffset() === offset) low = mid;
    else high = mid;
  }
  return high;
}

/** Start of this occurrence of the civil hour, or its partial-hour transition. */
export function civilHourStart(timestamp: number): number {
  const candidate = timestamp - minuteRemainder(timestamp);
  return offsetTransition(candidate, timestamp) ?? candidate;
}

/** Next local :00 or offset transition, without merging repeated occurrences. */
export function nextCivilHourStart(timestamp: number): number {
  const candidate = timestamp + HOUR_MS - minuteRemainder(timestamp);
  return offsetTransition(timestamp, candidate) ?? candidate;
}

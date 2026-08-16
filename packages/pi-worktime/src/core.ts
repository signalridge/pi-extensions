import { performance } from "node:perf_hooks";

/** A clock returning a monotonic millisecond value. */
export type WorktimeClock = () => number;

export interface Worktime {
  /** Reset accumulated active time; a running span remains running from now. */
  reset(): void;
  /** Start an active span. Repeated calls do not restart the span. */
  start(): void;
  /** End the active span. Repeated calls do not add time. */
  end(): void;
  /** Return the accumulated active time in milliseconds. */
  elapsed(): number;
  readonly running: boolean;
}

const MAX_DURATION_MS = Number.MAX_VALUE;

function readClock(clock: WorktimeClock): number | undefined {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function clampDuration(value: number): number {
  if (value <= 0 || Number.isNaN(value)) return 0;
  if (value === Number.POSITIVE_INFINITY) return MAX_DURATION_MS;
  if (!Number.isFinite(value)) return 0;
  return value;
}

function addDurations(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? clampDuration(sum) : MAX_DURATION_MS;
}

function activeSpan(start: number | undefined, current: number | undefined): number {
  if (start === undefined || current === undefined) return 0;
  const difference = current - start;
  if (difference === Number.POSITIVE_INFINITY) return MAX_DURATION_MS;
  if (!Number.isFinite(difference) || difference <= 0) return 0;
  return difference;
}

/**
 * Create an active-time state machine.
 *
 * Time is accumulated only while running. Invalid clock samples contribute no
 * time, and injected samples are normalized to a nondecreasing sequence so a
 * wall-clock correction cannot make the public duration regress. The default
 * clock is monotonic; the clock is injectable so lifecycle behavior can be
 * deterministic in tests without replacing global time APIs.
 */
export function createWorktime(clock: WorktimeClock = () => performance.now()): Worktime {
  let totalMs = 0;
  let running = false;
  let runStart: number | undefined;
  let lastClockSample: number | undefined;

  const readSample = (): number | undefined => {
    const sample = readClock(clock);
    if (sample === undefined) return undefined;
    if (lastClockSample !== undefined && sample < lastClockSample) return lastClockSample;
    lastClockSample = sample;
    return sample;
  };

  return {
    reset(): void {
      totalMs = 0;
      runStart = running ? readSample() : undefined;
    },

    start(): void {
      if (running) return;
      running = true;
      runStart = readSample();
    },

    end(): void {
      if (!running) return;
      totalMs = addDurations(totalMs, activeSpan(runStart, readSample() ?? lastClockSample));
      running = false;
      runStart = undefined;
    },

    elapsed(): number {
      if (!running) return totalMs;
      const current = readSample();
      if (runStart === undefined) {
        // An invalid sample cannot establish a span. A later valid sample is a
        // safe new baseline rather than an invitation to count unknown time.
        runStart = current;
        return totalMs;
      }
      return addDurations(totalMs, activeSpan(runStart, current ?? lastClockSample));
    },

    get running(): boolean {
      return running;
    },
  };
}

/** Format a duration compactly as `1h 2m 3s`, `2m 3s`, or `3s`. */
export function formatDuration(milliseconds: number): string {
  const duration = Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : 0;
  const totalSeconds = Math.floor(duration / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

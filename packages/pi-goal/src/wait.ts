/**
 * wait.ts — `goal_wait`, the difference between "not finished" and "waiting".
 *
 * A goal that depends on something outside the session — CI finishing, a review
 * landing, a colleague replying — has no work left to do right now, but is not
 * complete and is not blocked. Without a way to say so, the model either keeps
 * burning continuation turns re-checking, or reports a blocker that is not one.
 *
 * `goal_wait` says it: the goal stops, stays resumable, records why, and either
 * waits for the next real message or wakes itself on a deadline.
 *
 * The minimum delay is the load-bearing constant. A model asked to "wait a
 * moment" will happily pass 100ms, which is a polling loop wearing a wait's
 * clothing — the same continuation burn the tool exists to prevent. Requests
 * below the floor are clamped rather than refused, since the model's intent
 * ("wait, then check") is right even when its number is not.
 */

export interface GoalWait {
  reason: string;
  /** Epoch ms of the safety wake-up. Absent = wait for external input only. */
  resumeAt?: number;
}

export const MAX_GOAL_WAIT_REASON_LENGTH = 1_000;
/** Floor on a requested delay. Below this a "wait" is really a poll. */
export const MIN_GOAL_WAIT_DELAY_MS = 10_000;
/** `setTimeout` overflows above this and fires immediately, which is the opposite of waiting. */
export const MAX_GOAL_WAIT_DELAY_MS = 2_147_483_647;
/** Largest value `Date` represents; anything beyond is not a timestamp. */
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

/**
 * Both the requested delay and the one that will actually apply, so a caller
 * can tell the model its number was clamped instead of silently substituting.
 */
export function resolveGoalWaitDelay(resumeAfterMs: number | undefined): {
  requestedMs?: number;
  effectiveMs?: number;
} {
  if (resumeAfterMs === undefined) return {};
  return {
    requestedMs: resumeAfterMs,
    effectiveMs: Math.max(MIN_GOAL_WAIT_DELAY_MS, resumeAfterMs),
  };
}

/** Build the persisted wait record. `now` is injectable so tests are not timing-dependent. */
export function createGoalWait(reason: string, resumeAfterMs: number | undefined, now = Date.now()): GoalWait {
  const { effectiveMs } = resolveGoalWaitDelay(resumeAfterMs);
  return {
    reason,
    ...(effectiveMs === undefined ? {} : { resumeAt: now + effectiveMs }),
  };
}

/**
 * Validate a wait read back from persisted state.
 *
 * Rejects rather than repairs: a malformed `resumeAt` would otherwise schedule
 * a timer at an arbitrary moment, and a goal that wakes at the wrong time is
 * worse than one that waits for a real message.
 */
export function normalizeGoalWait(value: unknown): GoalWait | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (!reason || reason.length > MAX_GOAL_WAIT_REASON_LENGTH) return undefined;
  if (!Object.hasOwn(record, "resumeAt")) return { reason };
  if (
    typeof record.resumeAt !== "number" ||
    !Number.isSafeInteger(record.resumeAt) ||
    record.resumeAt < 0 ||
    record.resumeAt > MAX_DATE_TIMESTAMP_MS
  ) {
    return undefined;
  }
  return { reason, resumeAt: record.resumeAt };
}

/**
 * The single wake-up timer.
 *
 * Generation-counted rather than merely cleared: a timer already in flight
 * cannot be un-fired, so a callback that was scheduled before a `clear()` must
 * recognize that it is stale and do nothing. Without that, a goal cleared or
 * replaced microseconds before its deadline would still be woken.
 */
export class GoalWaitTimer {
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;

  clear(): void {
    this.generation += 1;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(resumeAt: number, onDue: () => void): void {
    this.clear();
    const generation = this.generation;
    // A deadline already past fires on the next tick rather than never, and one
    // beyond the timer range is capped instead of overflowing to immediate.
    const delay = Math.max(0, Math.min(MAX_GOAL_WAIT_DELAY_MS, resumeAt - Date.now()));
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.timer = undefined;
      onDue();
    }, delay);
  }
}

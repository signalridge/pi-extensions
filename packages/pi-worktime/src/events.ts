import { types as nodeTypes } from "node:util";

export const WORKTIME_UPDATE_EVENT = "worktime:update";

export interface WorktimeUpdatePayload {
  ms: number;
  running: boolean;
}

type PlainObject = { [key: PropertyKey]: unknown };

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null) return false;

  try {
    if (nodeTypes.isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function normalizeWorktimeUpdatePayload(value: unknown): WorktimeUpdatePayload | undefined {
  if (!isPlainObject(value)) return undefined;

  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("ms") || !keys.includes("running")) return undefined;

    const milliseconds = Object.getOwnPropertyDescriptor(value, "ms");
    const running = Object.getOwnPropertyDescriptor(value, "running");
    if (!milliseconds || !running || !("value" in milliseconds) || !("value" in running)) return undefined;

    if (
      typeof milliseconds.value !== "number" ||
      !Number.isFinite(milliseconds.value) ||
      milliseconds.value < 0 ||
      typeof running.value !== "boolean"
    ) {
      return undefined;
    }

    return Object.freeze({
      ms: milliseconds.value,
      running: running.value,
    });
  } catch {
    return undefined;
  }
}

/**
 * Parse and normalize an event payload into a fresh immutable snapshot.
 * Proxies, accessors, extra keys, and invalid field values are rejected.
 */
export function parseWorktimeUpdatePayload(value: unknown): WorktimeUpdatePayload | undefined {
  return normalizeWorktimeUpdatePayload(value);
}

/** Validate the exact, JSON-shaped payload published on the worktime bus. */
export function isWorktimeUpdatePayload(value: unknown): value is WorktimeUpdatePayload {
  return normalizeWorktimeUpdatePayload(value) !== undefined;
}

/** Alias for callers that prefer validator terminology. */
export function validateWorktimeUpdatePayload(value: unknown): value is WorktimeUpdatePayload {
  return isWorktimeUpdatePayload(value);
}

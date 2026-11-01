import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { JobManager, StartOptions } from "./contracts.js";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Revalidate final hook-mutated inputs against our original registered schema. */
export function finalParameters<T>(schema: TSchema, parameters: T): T {
  if (!Value.Check(schema, parameters)) throw new Error("Invalid final background tool parameters");
  const snapshot = structuredClone(parameters);
  if (!Value.Check(schema, snapshot)) throw new Error("Invalid final background tool parameters");
  return freeze(snapshot);
}

export function startSnapshot(options: StartOptions): StartOptions {
  return freeze(
    structuredClone({
      ...options,
      description: options.description ?? options.command.slice(0, 200),
      attention: options.attention ?? "turn",
    }),
  );
}

/** Probe the captured owner closure, not a newly created manager wrapper. */
export function assertLaunchCurrent(manager: JobManager, signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Background operation aborted");
  manager.list();
  if (signal?.aborted) throw new Error("Background operation aborted");
}

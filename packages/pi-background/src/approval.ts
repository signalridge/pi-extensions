import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  APPROVAL_ADAPTER_QUERY_CHANNEL,
  captureApprovalService,
  escapeDisplay,
  hashBytes,
  validateAdapterQuery,
  validateOperation,
} from "@signalridge/pi-approval-core";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { JobManager, StartOptions } from "./contracts.js";

export type CommandTool = "bash_background" | "monitor";

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

/** Capture synchronously; absence alone permits ordinary ungated operation. */
export function commandApproval(
  pi: ExtensionAPI,
  toolName: CommandTool,
  toolCallId: string,
  manager: JobManager,
  options: StartOptions,
  signal?: AbortSignal,
): { readonly pending: Promise<void>; readonly guard: () => void } | undefined {
  assertLaunchCurrent(manager, signal);
  const captured = pi.events ? captureApprovalService(pi.events) : undefined;
  if (!captured) return undefined;
  const guard = () => {
    assertLaunchCurrent(manager, signal);
    captured.assertCurrent();
  };
  // Explicit null represents monitor's unlimited deadline, not bash's default.
  const normalized = JSON.stringify({ ...options, timeoutMs: options.timeoutMs ?? null });
  const operation = validateOperation({
    kind: "command",
    toolName,
    source: "background",
    toolCallId,
    inputHash: hashBytes(normalized),
    command: options.command,
    cwd: options.cwd,
    preview: `${toolName} normalized launch inputs (timeoutMs null means no deadline):\n${escapeDisplay(normalized)}`,
  });
  assertLaunchCurrent(manager, signal);
  const pending = captured.service.request(
    operation,
    Object.freeze({
      signal,
      isCurrent: () => {
        guard();
        return true;
      },
    }),
  );
  return Object.freeze({ pending, guard });
}

/** Extension-owned synchronous capability; no process/UI resources in the factory. */
export function registerApprovalAdapter(
  pi: ExtensionAPI,
  schemas: ReadonlyMap<string, TSchema>,
  manager: (ctx: ExtensionContext) => JobManager,
): void {
  if (!pi.events) return; // Older lightweight API fixtures have no event bus.
  let context: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  const subscribe = () => {
    if (unsubscribe) return;
    unsubscribe = pi.events.on(APPROVAL_ADAPTER_QUERY_CHANNEL, (value: unknown) => {
      let query: ReturnType<typeof validateAdapterQuery>;
      try {
        query = validateAdapterQuery(value);
      } catch {
        return;
      }
      if (query.toolName !== "bash_background" && query.toolName !== "monitor") return;
      const parameters = schemas.get(query.toolName);
      if (!context || !parameters) return;
      try {
        manager(context).list();
        const effective = pi.getAllTools().find((tool) => tool.name === query.toolName);
        if (effective?.parameters !== parameters) return;
      } catch {
        return;
      }
      query.respond(Object.freeze({ version: 1, toolName: query.toolName, parameters }));
    });
  };
  // Subscriptions are not launch resources; session lifecycle owns their cleanup.
  subscribe();
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    subscribe();
  });
  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
  });
  pi.on("session_shutdown", () => {
    context = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  });
}

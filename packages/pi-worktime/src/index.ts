import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorktime, formatDuration, type WorktimeClock } from "./core.js";
import { parseWorktimeUpdatePayload, WORKTIME_UPDATE_EVENT, type WorktimeUpdatePayload } from "./events.js";

const WORKTIME_STATUS_KEY = "worktime";
const UPDATE_INTERVAL_MS = 1_000;
type IntervalHandle = ReturnType<typeof setInterval>;
type IntervalScheduler = (callback: () => void, delay: number) => IntervalHandle;
type IntervalCanceller = (handle: IntervalHandle) => void;

export interface WorktimeExtensionOptions {
  clock?: WorktimeClock;
  setInterval?: IntervalScheduler;
  clearInterval?: IntervalCanceller;
}

function sessionManagerOf(ctx: ExtensionContext): ExtensionContext["sessionManager"] | undefined {
  try {
    return ctx.sessionManager;
  } catch {
    return undefined;
  }
}

function unrefInterval(handle: IntervalHandle): void {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) return;

  try {
    const unref = (handle as unknown as { unref?: unknown }).unref;
    if (typeof unref === "function") unref.call(handle);
  } catch {
    // Browser-like or test schedulers may not expose a native unref handle.
  }
}

/** Register the worktime lifecycle handlers, with clock/timer seams for tests. */
export function registerWorktime(pi: ExtensionAPI, options: WorktimeExtensionOptions = {}): void {
  const worktime = createWorktime(options.clock);
  const schedule = options.setInterval ?? ((callback, delay) => setInterval(callback, delay));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle));

  let active = false;
  let sessionGeneration = 0;
  let activeSessionManager: ExtensionContext["sessionManager"] | undefined;
  let activeContext: ExtensionContext | undefined;
  let interval: IntervalHandle | undefined;
  let intervalToken = 0;

  const ownsSession = (ctx: ExtensionContext): boolean => {
    if (!active || activeSessionManager === undefined) return false;
    return sessionManagerOf(ctx) === activeSessionManager;
  };

  const clearTimer = (): void => {
    intervalToken += 1;
    const current = interval;
    interval = undefined;
    if (current === undefined) return;
    try {
      cancel(current);
    } catch {
      // Timer teardown is best effort during host shutdown.
    }
  };

  const updateStatus = (ctx: ExtensionContext, payload: WorktimeUpdatePayload): void => {
    try {
      if (ctx.mode !== "tui") return;
      ctx.ui.setStatus(WORKTIME_STATUS_KEY, formatDuration(payload.ms));
    } catch {
      // UI teardown can race a lifecycle callback; event publication remains valid.
    }
  };

  const clearOwnedStatus = (ctx: ExtensionContext): void => {
    try {
      if (ctx.mode !== "tui") return;
      ctx.ui.setStatus(WORKTIME_STATUS_KEY, undefined);
    } catch {
      // UI teardown can race a lifecycle callback; clearing is best-effort.
    }
  };

  const deactivateStaleSession = (capturedManager: ExtensionContext["sessionManager"], generation: number): void => {
    if (!active || generation !== sessionGeneration || activeSessionManager !== capturedManager) return;
    clearTimer();
    worktime.end();
    active = false;
    activeSessionManager = undefined;
    activeContext = undefined;
    // Do not publish or call UI APIs through a context Pi has invalidated.
  };

  const publish = (ctx: ExtensionContext): void => {
    if (!ownsSession(ctx)) return;

    const milliseconds = worktime.elapsed();
    const running = worktime.running;
    const eventPayload = parseWorktimeUpdatePayload({ ms: milliseconds, running });
    const statusPayload = parseWorktimeUpdatePayload({ ms: milliseconds, running });
    if (eventPayload === undefined || statusPayload === undefined) return;
    const generation = sessionGeneration;

    try {
      pi.events.emit(WORKTIME_UPDATE_EVENT, eventPayload);
    } catch {
      // A third-party event listener must not prevent timer or session cleanup.
    }
    if (active && generation === sessionGeneration && ownsSession(ctx)) updateStatus(ctx, statusPayload);
  };

  const startTimer = (): void => {
    if (interval !== undefined) return;
    const generation = sessionGeneration;
    const capturedContext = activeContext;
    const capturedManager = activeSessionManager;
    if (capturedContext === undefined || capturedManager === undefined) return;
    const token = ++intervalToken;
    const handle = schedule(() => {
      if (token !== intervalToken || !active || generation !== sessionGeneration) return;
      if (sessionManagerOf(capturedContext) !== capturedManager || activeSessionManager !== capturedManager) {
        deactivateStaleSession(capturedManager, generation);
        return;
      }
      const ctx = activeContext;
      if (ctx === undefined || !ownsSession(ctx)) {
        deactivateStaleSession(capturedManager, generation);
        return;
      }
      if (!worktime.running) return;
      publish(ctx);
    }, UPDATE_INTERVAL_MS);
    interval = handle;
    unrefInterval(handle);
  };

  pi.on("session_start", (_event, ctx) => {
    const sessionManager = sessionManagerOf(ctx);
    if (sessionManager === undefined) return;
    sessionGeneration += 1;
    clearTimer();
    worktime.end();
    worktime.reset();
    active = true;
    activeSessionManager = sessionManager;
    activeContext = ctx;
    publish(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    const sessionManager = sessionManagerOf(ctx);
    if (sessionManager === undefined) return;
    sessionGeneration += 1;
    clearTimer();
    worktime.end();
    worktime.reset();
    active = true;
    activeSessionManager = sessionManager;
    activeContext = ctx;
    publish(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user" || !ownsSession(ctx)) return;
    activeContext = ctx;
    worktime.reset();
    publish(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    activeContext = ctx;
    worktime.start();
    startTimer();
    publish(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    activeContext = ctx;
    worktime.end();
    clearTimer();
    publish(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    const shutdownGeneration = sessionGeneration + 1;
    sessionGeneration = shutdownGeneration;
    clearTimer();
    worktime.end();
    publish(ctx);
    // An event listener can synchronously begin a replacement session. Do not
    // clear its status or deactivate its state from this old shutdown.
    if (sessionGeneration !== shutdownGeneration || !active || !ownsSession(ctx)) return;
    active = false;
    activeSessionManager = undefined;
    activeContext = undefined;
    clearOwnedStatus(ctx);
  });

  pi.registerCommand("worktime", {
    description: "Show how long the agent worked on the current prompt",
    handler: async (_args, ctx) => {
      let hasUI = false;
      try {
        hasUI = ctx.hasUI;
      } catch {
        return;
      }
      if (!hasUI) return;
      if (!active || !ownsSession(ctx)) {
        try {
          ctx.ui.notify("Worktime unavailable: not initialized for this session.", "warning");
        } catch {
          // A stale UI context may already have been disposed.
        }
        return;
      }
      try {
        ctx.ui.notify(`Agent worked ${formatDuration(worktime.elapsed())} on this prompt`, "info");
      } catch {
        // UI teardown should not turn an informational command into a failure.
      }
    },
  });
}

export default function worktime(pi: ExtensionAPI): void {
  registerWorktime(pi);
}

export { createWorktime, formatDuration, type Worktime, type WorktimeClock } from "./core.js";
export type { WorktimeUpdatePayload } from "./events.js";
export {
  isWorktimeUpdatePayload,
  parseWorktimeUpdatePayload,
  validateWorktimeUpdatePayload,
  WORKTIME_UPDATE_EVENT,
} from "./events.js";

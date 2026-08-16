import type { AgentSession, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

type TeardownReason = SessionShutdownEvent["reason"];

interface TeardownState {
  promise: Promise<void>;
}

const teardownStates = new WeakMap<AgentSession, TeardownState>();

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Deliver Pi's public session_shutdown lifecycle event, then dispose a child
 * session. The WeakMap makes the sequence idempotent across normal eviction,
 * quarantine, late handoff, and manager shutdown.
 */
export function shutdownAndDisposeSession(
  session: AgentSession,
  reason: TeardownReason = "quit",
): Promise<void> {
  const existing = teardownStates.get(session);
  if (existing) return existing.promise;

  let resolveTeardown!: () => void;
  let rejectTeardown!: (reason: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveTeardown = resolve;
    rejectTeardown = reject;
  });
  // Publish the in-flight state before invoking user lifecycle handlers so a
  // re-entrant teardown request observes and awaits the same promise.
  teardownStates.set(session, { promise });

  void (async () => {
    let shutdownError: Error | undefined;
    try {
      const runner = session.extensionRunner;
      if (runner) await runner.emit({ type: "session_shutdown", reason });
    } catch (error: unknown) {
      shutdownError = errorValue(error);
    }

    let disposeError: Error | undefined;
    try {
      session.dispose();
    } catch (error: unknown) {
      disposeError = errorValue(error);
    }

    if (shutdownError && disposeError) {
      throw new AggregateError([shutdownError, disposeError], "Child session shutdown and disposal both failed");
    }
    if (shutdownError) throw shutdownError;
    if (disposeError) throw disposeError;
  })().then(resolveTeardown, rejectTeardown);
  return promise;
}

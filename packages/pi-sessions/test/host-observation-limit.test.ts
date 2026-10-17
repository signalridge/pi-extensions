import { expect, test } from "vitest";
import { deferred, fixture } from "./support.js";

// Real reverse extension order: Pi 1.0.4 returns on the earlier veto. There
// is no public attempt observer or RPC draft epoch/conditional-write API.
test.each([false, true])(
  "earlier extension veto is unobservable; latest RPC Yes=%s explicitly authorizes replacement",
  async (approve) => {
    const entered = deferred<void>();
    const answer = deferred<boolean>();
    let signal: AbortSignal | undefined;
    const f = await fixture({
      before: (pi) =>
        pi.on("session_before_switch", (_event, ctx) =>
          ctx.sessionManager !== f.manager ? { cancel: true } : undefined,
        ),
      ui: {
        confirm: async (title, _message, options) => {
          if (title === "Load approved summary into client editor?") {
            signal = options?.signal;
            entered.resolve();
            return answer.promise;
          }
          return true;
        },
      },
    });
    let running: Promise<void> | undefined;
    try {
      f.editorResults.push("reviewed excerpt", "approved summary");
      running = f.command("handoff", "continue");
      await entered.promise;
      expect((await f.runtime.newSession()).cancelled).toBe(true);
      expect(signal?.aborted).toBe(false); // The sessions observer never received the attempt.
      f.editorText = "client-local newer draft"; // Invisible through the public RPC UI.
      answer.resolve(approve); // A client must reject stale consent to preserve this draft.
      await running;
      expect(f.editorText).toBe(approve ? "approved summary" : "client-local newer draft");
      expect(f.destinationTurns).toBe(0);
    } finally {
      answer.resolve(false);
      await running;
      await f.cleanup();
    }
  },
);

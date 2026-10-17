import { expect, test, vi } from "vitest";
import { deferred, fixture, model, response } from "./support.js";

// Each replacement creates real Pi 1.0.4 services, extension factories and event
// buses. A source-runtime Owner or event-bus subscription cannot fence this UI.
test.each(["sessions", "handoff"])(
  "pending destination RPC consent owns /%s and retires on a vetoed native navigation attempt",
  async (command) => {
    const consent = deferred<boolean>();
    const entered = deferred<void>();
    const f = await fixture({
      extra: (pi) =>
        pi.on("session_before_switch", (_event, ctx) =>
          ctx.sessionManager !== f.manager ? { cancel: true } : undefined,
        ),
      ui: {
        confirm: async (title) => {
          if (title === "Load approved summary into client editor?") {
            entered.resolve();
            return consent.promise; // Deliberately ignores the public abort signal.
          }
          return true;
        },
      },
    });
    let running: Promise<void> | undefined;
    try {
      f.editorResults.push("reviewed excerpt", "approved destination summary");
      running = f.command("handoff", "continue");
      await entered.promise;
      await f.command(command, "invalid");
      expect(f.notices.some((notice) => notice.includes("interaction is already open"))).toBe(true);
      expect((await f.runtime.newSession()).cancelled).toBe(true);
      const settled = await Promise.race([
        running.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 500)),
      ]);
      expect(settled).toBe(true); // Retirement must not wait for an RPC client reply.
      f.editorText = "newer client draft";
      consent.resolve(true);
      await running;
      await Promise.resolve();
      expect(f.editorText).toBe("newer client draft");
      expect(f.destinationTurns).toBe(0);
    } finally {
      consent.resolve(false);
      await running;
      await f.cleanup();
    }
  },
);

// Actual native tree/fork/compact vetoes, native shutdown/model mutation, and
// the SDK's public agent_start event all retire destination-owned consent.
test.each(["tree", "fork", "compact", "shutdown", "model", "agent_start"])(
  "%s fences a pending destination consent, even if its client ignores abort",
  async (boundary) => {
    const consent = deferred<boolean>();
    const entered = deferred<void>();
    let signal: AbortSignal | undefined;
    const f = await fixture({
      extra: (pi) => {
        pi.on("session_before_tree", () => ({ cancel: true }));
        pi.on("session_before_fork", () => ({ cancel: true }));
        pi.on("session_before_compact", () => ({ cancel: true }));
      },
      ui: {
        confirm: async (title, _message, options) => {
          if (title === "Load approved summary into client editor?") {
            signal = options?.signal;
            entered.resolve();
            return consent.promise;
          }
          return true;
        },
      },
    });
    let running: Promise<void> | undefined;
    try {
      if (boundary === "compact") {
        const native = f.runtime.newSession.bind(f.runtime);
        vi.spyOn(f.runtime, "newSession").mockImplementation((options) =>
          native({
            ...options,
            setup: async (manager) => {
              await options?.setup?.(manager);
              // Provide real compactable context before destination ownership
              // starts; these are fixture messages, never an extension turn.
              manager.appendMessage({ role: "user", content: "earlier context", timestamp: 3 });
              manager.appendMessage(response("prior answer"));
              manager.appendMessage({ role: "user", content: "latest context ".repeat(10_000), timestamp: 4 });
            },
          }),
        );
      }
      f.editorResults.push("reviewed excerpt", "approved destination summary");
      running = f.command("handoff", "continue");
      await entered.promise;
      const session = f.runtime.session;
      const entries = session.sessionManager.getBranch();
      if (boundary === "tree") expect((await session.navigateTree(entries[0].id)).cancelled).toBe(true);
      else if (boundary === "fork")
        expect((await f.runtime.fork(entries[0].id, { position: "at" })).cancelled).toBe(true);
      else if (boundary === "compact") await expect(session.compact()).rejects.toThrow("Compaction cancelled");
      else if (boundary === "shutdown") await f.runtime.dispose();
      else if (boundary === "model") {
        vi.spyOn(f.runtime.services.modelRuntime, "checkAuth").mockResolvedValue({ type: "api_key" });
        await session.setModel({ ...model, id: "different" });
      } else await session.extensionRunner.emit({ type: "agent_start" });
      expect(signal?.aborted).toBe(true);
      const settled = await Promise.race([
        running.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(settled).toBe(true);
      f.editorText = "newer destination draft";
      consent.resolve(true);
      await running;
      await Promise.resolve();
      expect(f.editorText).toBe("newer destination draft");
      expect(f.destinationTurns).toBe(boundary === "agent_start" ? 1 : 0); // the one explicitly injected event
    } finally {
      consent.resolve(false);
      await running;
      vi.restoreAllMocks();
      await f.cleanup();
    }
  },
);

test("normal destination Yes writes the approved editor draft once, under destination ownership, without a turn", async () => {
  const consent = deferred<boolean>();
  const entered = deferred<void>();
  const f = await fixture({
    ui: {
      confirm: async (title) => {
        if (title === "Load approved summary into client editor?") {
          entered.resolve();
          return consent.promise;
        }
        return true;
      },
    },
  });
  let running: Promise<void> | undefined;
  try {
    const write = vi.spyOn(f.ui, "setEditorText");
    f.editorResults.push("reviewed excerpt", "approved destination summary");
    running = f.command("handoff", "continue");
    await entered.promise;
    expect(f.runtime.session).not.toBe(f.source);
    expect(write).not.toHaveBeenCalled();
    consent.resolve(true);
    await running;
    expect(write).toHaveBeenCalledExactlyOnceWith("approved destination summary");
    expect(f.editorText).toBe("approved destination summary");
    expect(f.destinationTurns).toBe(0);
    expect(f.runtime.session.sessionManager.buildSessionContext().messages).toEqual([]);
    await f.command("sessions", "invalid");
    expect(f.notices.at(-1)).toBe("Usage: /sessions [all]"); // lock released
  } finally {
    consent.resolve(false);
    await running;
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

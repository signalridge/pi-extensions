import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { HANDOFF_TYPE, readHandoff } from "../src/handoff.js";
import { Owner } from "../src/ownership.js";
import { deferred, fixture, model } from "./support.js";

for (const boundary of ["branch", "message", "model"] as const) {
  test(`${boundary} change during a later async before-switch handler revokes persisted prefill only`, async () => {
    const entered = deferred<void>();
    const permit = deferred<void>();
    const f = await fixture({
      extra: (pi) =>
        pi.on("session_before_switch", async (_event, ctx) => {
          if (ctx.sessionManager === f.manager) {
            entered.resolve();
            await permit.promise;
          }
        }),
    });
    let running: Promise<void> | undefined;
    try {
      f.editorResults.push("reviewed excerpt", "approved recovery summary");
      running = f.command("handoff", "continue");
      await entered.promise;
      if (boundary !== "model") {
        if (boundary === "message")
          f.manager.appendMessage({ role: "user", content: "new native context after preflight", timestamp: 100 });
        else f.manager.appendCustomEntry("new source state");
        // Allow the real owner's public state monitor to observe the change.
        await new Promise((resolve) => setTimeout(resolve, 120));
      } else {
        vi.spyOn(f.runtime.services.modelRuntime, "checkAuth").mockResolvedValue({ type: "api_key" });
        await f.source.setModel({ ...model, id: "changed" });
        expect(f.source.model?.id).toBe("changed");
      }
      permit.resolve();
      await running;
      expect(f.runtime.session).not.toBe(f.source); // Native replacement has no final cancellable precondition.
      const entry = f.runtime.session.sessionManager
        .getBranch()
        .find((item) => item.type === "custom" && item.customType === HANDOFF_TYPE);
      const saved = entry?.type === "custom" ? readHandoff(entry.data) : undefined;
      expect(saved?.summary).toBe("approved recovery summary");
      expect(saved?.prefill).toBeUndefined();
      // Native parent links remain live. After preflight revocation, retain the
      // newer source history, but never revive its old editor-prefill approval.
      expect(saved?.parent.path).toBe(f.manager.getSessionFile());
      if (boundary === "message") {
        const parent = SessionManager.open(saved?.parent.path as string);
        expect(parent.getBranch().at(-1)).toMatchObject({
          type: "message",
          message: { role: "user", content: "new native context after preflight" },
        });
      }
      expect(f.confirmations).not.toContain("Load approved summary into client editor?");
      expect(f.editorText).toBe("original unsent draft");
      expect(f.destinationTurns).toBe(0);
      await f.command("handoff", "recover");
      expect(f.editorText).toBe("approved recovery summary");
    } finally {
      permit.resolve();
      await running;
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
}

test("shutdown cannot authorize replacement after the owner already retired", async () => {
  const f = await fixture();
  try {
    const owner = new Owner(f.source.extensionRunner.createCommandContext(), true);
    owner.committing = "new";
    owner.retire();
    owner.shutdown({ type: "session_shutdown", reason: "new" });
    expect(owner.replacementStarted).toBe(true); // Retain the recovery parent after native teardown.
    expect(owner.replacementApproved).toBe(false);
  } finally {
    await f.cleanup();
  }
});

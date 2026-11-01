import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { OverflowWakeGuard, overflowEpisode } from "../src/context-overflow.js";

it.each(["HTTP 503 unavailable", "HTTP 429 rate limit"])(
  "keeps pending wakes held after overflow -> %s until meaningful recovery",
  (errorMessage) => {
    const manager = SessionManager.inMemory();
    const overflow = manager.appendMessage(
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Your input exceeds the context window of this model",
      }),
    );
    manager.appendMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage }));
    manager.appendMessage(fauxAssistantMessage("", { stopReason: "aborted" }));
    const notify = vi.fn();
    const ctx = {
      sessionManager: manager,
      model: { contextWindow: 200_000 },
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionContext;
    const guard = new OverflowWakeGuard({ getCommands: () => [] }, "pending results are held");
    expect(overflowEpisode(ctx)).toBe(overflow);
    expect(guard.holds(ctx)).toBe(true);
    expect(guard.holds(ctx)).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    manager.appendMessage(fauxAssistantMessage("success"));
    expect(guard.holds(ctx)).toBe(false);
  },
);

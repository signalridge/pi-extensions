import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { contextOverflowEpisode as overflowEpisode } from "../src/context-overflow.js";

const physical = fauxProvider({ provider: "physical", models: [{ id: "large", contextWindow: 200_000 }] }).getModel();
function fixture(input: number, known = true, explicit = false) {
  const manager = SessionManager.inMemory();
  const user = manager.appendMessage({ role: "user", content: "long input", timestamp: Date.now() });
  const assistant = manager.appendMessage({
    ...fauxAssistantMessage("answer", {
      stopReason: explicit ? "error" : "stop",
      errorMessage: explicit ? "Your input exceeds the context window of this model" : undefined,
    }),
    provider: physical.provider,
    model: physical.id,
    usage: {
      input,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const ctx = {
    sessionManager: manager,
    model: { ...physical, provider: "router", id: "virtual", contextWindow: 8000 },
    modelRegistry: { find: () => (known ? physical : undefined) },
  };
  return { manager, user, assistant, ctx };
}
it("uses the physical response window, not the selected virtual 8k limit", () => {
  expect(overflowEpisode(fixture(20_000).ctx)).toBeUndefined();
  const f = fixture(250_000);
  expect(overflowEpisode(f.ctx)).toBe(f.assistant);
  expect(overflowEpisode(fixture(250_000, false).ctx)).toBeUndefined();
  const unknown = fixture(0, false, true);
  expect(overflowEpisode(unknown.ctx)).toBe(unknown.assistant);
});
it.each(["shorten", "omit"])("persisted context_edit %s invalidates stale usage but not unrelated metadata", (mode) => {
  const f = fixture(250_000);
  f.manager.appendCustomEntry("unrelated", { replacement: "short" });
  expect(overflowEpisode(f.ctx)).toBe(f.assistant);
  f.manager.appendContextEdit(mode === "omit" ? f.assistant : f.user, mode === "omit" ? null : { content: "short" });
  expect(overflowEpisode(f.ctx)).toBeUndefined();
  f.manager.branch(f.assistant);
  expect(overflowEpisode(f.ctx)).toBe(f.assistant);
});
it("explicit overflow survives recovery-attempt omission without successful compaction", () => {
  const f = fixture(0, false, true);
  f.manager.appendContextEdit(f.user, { content: "short" });
  expect(overflowEpisode(f.ctx)).toBe(f.assistant);
  f.manager.appendContextEdit(f.assistant, null);
  expect(overflowEpisode(f.ctx)).toBe(f.assistant);
  f.manager.appendCompaction("repaired", f.user, 0);
  expect(overflowEpisode(f.ctx)).toBeUndefined();
});

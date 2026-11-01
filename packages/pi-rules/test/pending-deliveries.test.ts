import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { PendingDeliveries } from "../src/pending-deliveries.js";
import { parseRule } from "../src/rule.js";

function fixture() {
  const sessionManager = SessionManager.inMemory();
  const root = sessionManager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
  const branch = sessionManager.appendMessage({ role: "user", content: "branch", timestamp: Date.now() });
  const controller = new AbortController();
  const ctx = { sessionManager, signal: controller.signal };
  const parsed = parseRule("once", "/rules/once.md", "user", "---\ncondition: x\n---\nbody");
  if (parsed.kind !== "rule") throw new Error("invalid fixture");
  const rule = parsed.rule;
  const pending = new PendingDeliveries();
  const claim = pending.queue(ctx, "reminder", [rule], "owned body");
  const message = { content: "owned body", details: claim.details, display: false };
  return { sessionManager, ctx, root, branch, controller, pending, rule, claim, message };
}
it("deduplicates pending offers, authenticates details identity and admits exactly once", () => {
  const f = fixture();
  expect(f.pending.has("once", f.ctx)).toBe(true);
  expect(f.pending.admit({ ...f.message, details: structuredClone(f.claim.details) }, f.ctx)).toBeUndefined();
  expect(f.pending.admit({ ...f.message, details: { rules: ["once"] } }, f.ctx)).toBeUndefined();
  expect(f.pending.admit(f.message, f.ctx)).toEqual({ via: "reminder", rules: [f.rule] });
  expect(f.pending.admit(f.message, f.ctx)).toBeUndefined();
  expect(f.pending.has("once", f.ctx)).toBe(false);
});
it.each(["abort", "tree", "session", "retire", "content"])(
  "cancels pending ownership on %s without a stale receipt",
  (reason) => {
    const f = fixture();
    if (reason === "abort") f.controller.abort();
    if (reason === "tree") f.sessionManager.branch(f.root);
    if (reason === "retire") f.pending.clear();
    if (reason === "content") f.message.content = "copied body";
    const ctx = reason === "session" ? { ...f.ctx, sessionManager: SessionManager.inMemory() } : f.ctx;
    expect(f.pending.admit(f.message, ctx)).toBeUndefined();
    f.sessionManager.branch(f.branch);
    expect(f.pending.has("once", f.ctx)).toBe(false);
    const next = f.pending.queue({ ...f.ctx, signal: new AbortController().signal }, "offer", [f.rule], "next");
    expect(
      f.pending.admit({ content: "next", details: next.details, display: false }, { ...f.ctx, signal: undefined }),
    ).toEqual({ via: "offer", rules: [f.rule] });
  },
);

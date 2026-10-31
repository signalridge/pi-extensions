import { afterEach, expect, test, vi } from "vitest";
import { CompletionOutbox, type OutboxItem, type OutboxMessage } from "../src/completion-outbox.js";

function item(id: string, result = id): OutboxItem {
  return { ids: [id], build: () => ({ content: result, details: { id, description: id, status: "completed", toolUses: 0, turnCount: 0, totalTokens: 0, durationMs: 0, resultPreview: result } }) };
}
afterEach(() => vi.useRealTimers());
test("read results remain cancellable for the entire busy parent run", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const outbox = new CompletionOutbox(send, () => true);
  outbox.add(item("read"));
  vi.advanceTimersByTime(60 * 60_000);
  expect(send).not.toHaveBeenCalled();
  outbox.cancel("read");
  outbox.onTurnEnd("stop");
  expect(send).not.toHaveBeenCalled();
  outbox.dispose();
});
test("coalesces unrelated completion batches at one tool boundary", () => {
  const sent: OutboxMessage[] = [];
  const outbox = new CompletionOutbox(message => { sent.push(message); }, () => true);
  outbox.add(item("one")); outbox.add(item("two"));
  outbox.onTurnEnd("toolUse");
  expect(sent).toHaveLength(1);
  expect(sent[0].content).toContain("one"); expect(sent[0].content).toContain("two");
  expect(sent[0].details.others?.map(record => record.id)).toEqual(["two"]);
  outbox.onTurnEnd("stop"); expect(sent).toHaveLength(1);
  outbox.dispose();
});
test("idle hold does not inject during a newly started tool batch", () => {
  vi.useFakeTimers(); let running = false; const send = vi.fn();
  const outbox = new CompletionOutbox(send, () => running);
  outbox.add(item("one")); running = true; vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
  outbox.onTurnEnd("toolUse"); expect(send).toHaveBeenCalledTimes(1); outbox.dispose();
});
test("partial cancellation preserves unread peers and a newer entry supersedes the same pending key", () => {
  const send = vi.fn(); const outbox = new CompletionOutbox(send, () => true);
  outbox.add(item("one", "old")); outbox.add(item("one", "new")); outbox.add(item("two"));
  outbox.cancel("two"); outbox.onTurnEnd("stop");
  expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0].content).toBe("new"); outbox.dispose();
});
test.each(["aborted", "error"])("holds unread failures through parent %s until settled", reason => {
  vi.useFakeTimers(); let running = true; const send = vi.fn();
  const outbox = new CompletionOutbox(send, () => running);
  outbox.add(item("failure", "unread failure")); outbox.onTurnEnd(reason); expect(send).not.toHaveBeenCalled();
  running = false; outbox.onAgentEnd(); vi.advanceTimersByTime(200);
  expect(send).toHaveBeenCalledTimes(1); outbox.dispose();
});
test("retirement fences captured timers and late completions", () => {
  vi.useFakeTimers(); const send = vi.fn(); const outbox = new CompletionOutbox(send, () => false);
  outbox.add(item("one")); outbox.dispose(); outbox.add(item("two")); vi.runAllTimers(); outbox.onTurnEnd("stop");
  expect(send).not.toHaveBeenCalled();
});
test("retiring during payload construction fences the entire captured batch", () => {
  const send = vi.fn(); const outbox = new CompletionOutbox(send, () => true);
  outbox.add(item("one")); outbox.add({ ids: ["two"], build: () => { outbox.dispose(); return item("two").build(["two"]); } });
  outbox.onTurnEnd("stop"); expect(send).not.toHaveBeenCalled();
});
test("a throwing send retains unread work without an automatic retry loop", () => {
  const send = vi.fn().mockImplementationOnce(() => { throw new Error("send rejected"); });
  const outbox = new CompletionOutbox(send, () => true); outbox.add(item("one"));
  outbox.onTurnEnd("stop"); expect(send).toHaveBeenCalledTimes(1);
  outbox.onTurnEnd("toolUse"); expect(send).toHaveBeenCalledTimes(2); outbox.dispose();
});

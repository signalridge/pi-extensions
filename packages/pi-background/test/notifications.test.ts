import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEvent } from "../src/contracts.js";
import { type NotificationBatch, Notifications, safeText, truncateUtf8 } from "../src/notifications.js";

function event(id = "job", attention: "turn" | "context" = "turn"): JobEvent {
  return { jobId: id, description: "test", kind: "match", attention, text: "ready" };
}

function harness() {
  let ready = true;
  const sent: NotificationBatch[] = [];
  const failed = vi.fn();
  const outbox = new Notifications({
    ready: () => ready,
    send: (batch) => {
      sent.push(batch);
    },
    failed,
  });
  return {
    outbox,
    sent,
    failed,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("notification outbox", () => {
  it("consumes only observed terminal exits and preserves unread monitor matches", () => {
    const h = harness();
    h.setReady(false);
    h.outbox.enqueue({ ...event("done"), kind: "exit", text: "exit 1" });
    h.outbox.enqueue(event("done"));
    h.outbox.enqueue({ ...event("other"), kind: "exit" });
    h.outbox.consumeExit("done");
    h.setReady(true);
    h.outbox.flush();
    expect(h.sent[0].content).toContain("[match:done]");
    expect(h.sent[0].content).not.toContain("[exit:done]");
    expect(h.sent[0].content).toContain("[exit:other]");
    h.outbox.dispose();
  });
  it("reading the last ambiguous exit clears its obsolete delivery pause", () => {
    vi.useFakeTimers();
    const h = harness();
    h.outbox.enqueue({ ...event(), kind: "exit" });
    h.outbox.flush();
    vi.advanceTimersByTime(30_000);
    expect(h.outbox.deliveryPaused).toBe(true);
    h.outbox.consumeExit("job");
    expect(h.outbox.deliveryPaused).toBe(false);
    expect(h.outbox.count).toBe(0);
    h.outbox.enqueue({ ...event("next"), kind: "exit" });
    h.outbox.flush();
    expect(h.sent).toHaveLength(2);
    h.outbox.dispose();
  });
  it("consuming a pending exit does not swallow a future completion with that id", () => {
    const h = harness();
    h.setReady(false);
    h.outbox.consumeExit("job");
    h.outbox.enqueue({ ...event(), kind: "exit" });
    h.setReady(true);
    h.outbox.flush();
    expect(h.sent).toHaveLength(1);
    h.outbox.dispose();
  });
  it("an observed handed-off exit cannot keep an old wake alive or retry", () => {
    vi.useFakeTimers();
    const h = harness();
    h.outbox.enqueue({ ...event(), kind: "exit" });
    h.outbox.flush();
    const wake = h.sent[0].wakeId;
    h.outbox.consumeExit("job");
    expect(h.outbox.ownsWake(wake)).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    h.outbox.dispose();
  });
  it("coalesces output locally while busy, then wakes exactly once", () => {
    vi.useFakeTimers();
    const h = harness();
    h.setReady(false);
    for (let index = 0; index < 1000; index++) h.outbox.enqueue(event());
    vi.advanceTimersByTime(60_000);
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.count).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    h.setReady(true);
    h.outbox.settled();
    vi.advanceTimersByTime(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].triggerTurn).toBe(true);
    expect(h.sent[0].content).toContain("1000 events coalesced");
    h.outbox.acknowledge(h.sent[0].wakeId);
    h.outbox.settled();
    expect(h.outbox.count).toBe(0);
    expect(h.sent).toHaveLength(1);
    h.outbox.dispose();
  });

  it("context notifications never request a model turn and mixed batches do", () => {
    const h = harness();
    h.outbox.enqueue(event("one", "context"));
    h.outbox.flush();
    expect(h.sent[0].triggerTurn).toBe(false);
    h.outbox.acknowledge(h.sent[0].wakeId);
    h.outbox.enqueue(event("two", "context"));
    h.outbox.enqueue(event("three"));
    h.outbox.flush();
    expect(h.sent[1].triggerTurn).toBe(true);
    h.outbox.dispose();
  });

  it("bounds batches and prevents noisy jobs from starting a turn every line", () => {
    vi.useFakeTimers();
    const h = harness();
    for (let index = 0; index < 100; index++) h.outbox.enqueue({ ...event(String(index)), text: "日".repeat(4000) });
    h.outbox.flush();
    expect(h.outbox.count).toBe(32);
    expect(Buffer.byteLength(h.sent[0].content)).toBeLessThanOrEqual(8192);
    expect(h.sent[0].content).not.toContain("�");
    h.outbox.acknowledge(h.sent[0].wakeId);
    h.outbox.enqueue(event());
    vi.advanceTimersByTime(9999);
    expect(h.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sent).toHaveLength(2);
    h.outbox.dispose();
  });

  it("manual stop removes only its pending notices", () => {
    const h = harness();
    h.setReady(false);
    h.outbox.enqueue(event("a"));
    h.outbox.enqueue(event("b"));
    h.outbox.cancel("a");
    h.setReady(true);
    h.outbox.flush();
    expect(h.sent[0].jobIds).toEqual(["b"]);
    h.outbox.dispose();
  });

  it("preserves terminal events alongside the latest match", () => {
    const h = harness();
    h.outbox.enqueue(event());
    h.outbox.enqueue({ ...event(), kind: "exit", text: "exit 1" });
    h.outbox.enqueue({ ...event(), text: "new ready" });
    h.outbox.flush();
    expect(h.sent[0].content).toContain("exit 1");
    expect(h.sent[0].content).toContain("new ready");
    h.outbox.dispose();
  });

  it("deduplicates only the exact message acknowledgment", () => {
    const h = harness();
    h.outbox.enqueue(event());
    h.outbox.flush();
    h.outbox.acknowledge("unrelated");
    expect(h.outbox.count).toBe(1);
    h.outbox.acknowledge(h.sent[0].wakeId);
    expect(h.outbox.count).toBe(0);
    h.outbox.dispose();
  });

  it("bounds retry attempts and permits explicit recovery", () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const send = vi.fn(() => {
      throw new Error("unavailable");
    });
    const outbox = new Notifications({ ready: () => true, send, failed });
    outbox.enqueue(event("one", "context"));
    vi.advanceTimersByTime(31_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(outbox.count).toBe(1);
    expect(outbox.deliveryPaused).toBe(true);
    expect(failed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100_000);
    expect(send).toHaveBeenCalledTimes(3);
    outbox.retry();
    expect(send).toHaveBeenCalledTimes(4);
    outbox.dispose();
  });

  it("does not duplicate an accepted run missing its ACK", () => {
    const h = harness();
    h.outbox.enqueue(event());
    h.outbox.flush();
    h.outbox.started();
    h.outbox.settled();
    expect(h.outbox.deliveryPaused).toBe(true);
    expect(h.sent).toHaveLength(1);
    h.outbox.dispose();
  });

  it("pauses a consumed or asynchronously rejected wake even without a settled event", () => {
    vi.useFakeTimers();
    const h = harness();
    h.outbox.enqueue(event());
    h.outbox.flush();
    vi.advanceTimersByTime(30_000);
    expect(h.outbox.deliveryPaused).toBe(true);
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
    vi.advanceTimersByTime(90_000);
    expect(h.failed).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
    // A lengthy input hook can still accept that exact wake later.
    h.outbox.acknowledge(h.sent[0].wakeId);
    expect(h.outbox.deliveryPaused).toBe(false);
    expect(h.outbox.count).toBe(0);
    h.outbox.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the acknowledgment deadline when the last in-flight job is stopped", () => {
    vi.useFakeTimers();
    const h = harness();
    h.outbox.enqueue(event());
    h.outbox.flush();
    h.outbox.cancel("job");
    vi.advanceTimersByTime(60_000);
    expect(h.outbox.count).toBe(0);
    expect(h.outbox.deliveryPaused).toBe(false);
    expect(h.failed).not.toHaveBeenCalled();
    h.outbox.dispose();
  });

  it("retains complete job summaries across oversized batches instead of acknowledging omitted events", () => {
    vi.useFakeTimers();
    const h = harness();
    for (let index = 0; index < 12; index++) {
      h.outbox.enqueue({ ...event(String(index)), text: "日".repeat(8000) });
      h.outbox.enqueue({ ...event(String(index)), kind: "exit", text: "done" });
    }
    h.outbox.flush();
    const delivered = new Set<string>();
    while (h.outbox.count > 0) {
      const batch = h.sent.at(-1);
      if (!batch) throw new Error("missing batch");
      for (const id of batch.jobIds) {
        expect(batch.content).toContain(`[match:${id}]`);
        expect(batch.content).toContain(`[exit:${id}]`);
        expect(delivered.has(id)).toBe(false);
        delivered.add(id);
      }
      expect(Buffer.byteLength(batch.content)).toBeLessThanOrEqual(8192);
      h.outbox.acknowledge(batch.wakeId);
      vi.advanceTimersByTime(10_000);
    }
    expect(delivered.size).toBe(12);
    h.outbox.dispose();
  });

  it("defers settled handoff so navigation can dispose the owned timer", () => {
    vi.useFakeTimers();
    const h = harness();
    h.outbox.enqueue(event());
    h.outbox.settled();
    expect(h.sent).toHaveLength(0);
    h.outbox.dispose();
    vi.advanceTimersByTime(10_000);
    expect(h.sent).toHaveLength(0);
  });

  it("disposes timers and pending output on session changes", () => {
    vi.useFakeTimers();
    const h = harness();
    h.outbox.enqueue(event());
    h.outbox.dispose();
    h.outbox.enqueue(event());
    vi.runAllTimers();
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.count).toBe(0);
  });
});

it("removes terminal controls and bounds Unicode by bytes", () => {
  expect(safeText("\x1b]52;c;secret\x07\x1b[31mred\x1b[0m\x00")).toBe("red");
  const text = truncateUtf8("🎉".repeat(200), 100);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100);
  expect(text).not.toContain("�");
});

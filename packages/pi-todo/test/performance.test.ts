import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { TodoStore } from "../src/store.js";

/** Reproducible, synthetic only. Counters are evidence, not wall-time assertions.
 * Run this same fixture against the prepared index to compare canonical work.
 */
it("measures synthetic long-history canonical work, appends, tampering and bounded-history eviction", () => {
  expect(VERSION).toBe("1.5.0");
  const dir = mkdtempSync(join(tmpdir(), "todo-performance-"));
  const manager = SessionManager.create(dir, dir);
  const ctx = { sessionManager: manager } as unknown as ExtensionContext;
  // 192 separately owned strings, 12 MiB total bodies, nested native arrays.
  // Include tool results with omitted optional details, as in native tool history.
  for (let i = 0; i < 192; i++) {
    const content = [{ type: "text" as const, text: `${i}:${"x".repeat(64 * 1024)}` }];
    manager.appendMessage(
      i % 2
        ? {
            role: "toolResult",
            toolName: "synthetic",
            toolCallId: `synthetic-${i}`,
            content,
            details: undefined,
            isError: false,
            timestamp: i,
          }
        : { role: "user", content, timestamp: i },
    );
  }
  const store = new TodoStore({
    appendEntry: (type, data) => {
      manager.appendCustomEntry(type, data);
    },
  });
  const rows: object[] = [];
  const measure = (phase: string, action: () => void) => {
    let calls = 0;
    let bytes = 0;
    let hashCalls = 0;
    const native = JSON.stringify;
    const nativeHash = crypto.createHash;
    crypto.createHash = (...args: Parameters<typeof crypto.createHash>) => {
      hashCalls++;
      return nativeHash(...args);
    };
    syncBuiltinESMExports();
    // Avoid spies retaining every serialized megabyte result during memory measurements.
    JSON.stringify = (...args: unknown[]): string => {
      const result: string = Reflect.apply(native, JSON, args);
      calls++;
      if (result) bytes += Buffer.byteLength(result);
      return result;
    };
    global.gc?.();
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const start = performance.now();
    try {
      action();
    } finally {
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      const end = process.memoryUsage();
      JSON.stringify = native;
      crypto.createHash = nativeHash;
      syncBuiltinESMExports();
      global.gc?.();
      const retained = process.memoryUsage();
      rows.push({
        phase,
        calls,
        hashCalls,
        jsonBytes: bytes,
        elapsedMs: +elapsedMs.toFixed(3),
        cpuMs: +((used.user + used.system) / 1000).toFixed(3),
        heapDelta: end.heapUsed - memory.heapUsed,
        rssDelta: end.rss - memory.rss,
        retainedHeapDelta: retained.heapUsed - memory.heapUsed,
      });
    }
  };
  try {
    measure("cold-reconcile", () => {
      store.reconcile(ctx);
    });
    measure("warm-read-x20", () => {
      for (let i = 0; i < 20; i++) expect(store.read(ctx).revision).toBe(0);
    });
    measure("append", () => {
      expect(store.mutate(ctx, { action: "add", baseRevision: 0, title: "Synthetic" }).revision).toBe(1);
    });
    measure("warm-read-after-append-x20", () => {
      for (let i = 0; i < 20; i++) expect(store.read(ctx).revision).toBe(1);
    });
    const first = manager.getBranch()[0];
    if (first.type !== "message" || first.message.role !== "user" || !Array.isArray(first.message.content))
      throw new Error("Missing body");
    const block = first.message.content[0];
    if (block.type !== "text") throw new Error("Missing text");
    measure("deep-mutation", () => {
      block.text = "In-place deep mutation, same native ID";
      expect(() => store.read(ctx)).toThrow(/ownership/);
    });
    store.retire();
    global.gc?.();
    const retained = process.memoryUsage();
    // Deliberately exceed entry retention without large bodies: eviction must
    // recompute, not become an authority shortcut over unobserved old ancestors.
    const memory = SessionManager.inMemory();
    const memoryCtx = { sessionManager: memory } as unknown as ExtensionContext;
    for (let i = 0; i < 1200; i++) memory.appendMessage({ role: "user", content: `entry ${i}`, timestamp: i });
    const bounded = new TodoStore({
      appendEntry: (type, data) => {
        memory.appendCustomEntry(type, data);
      },
    });
    measure("over-entry-budget-reconcile", () => {
      bounded.reconcile(memoryCtx);
    });
    measure("over-entry-budget-read-x5", () => {
      for (let i = 0; i < 5; i++) expect(bounded.read(memoryCtx).revision).toBe(0);
    });
    const old = memory.getBranch()[0];
    if (old.type !== "message" || old.message.role !== "user") throw new Error("Missing old ancestor");
    old.message.content = "Changed outside retention window";
    expect(() => bounded.read(memoryCtx)).toThrow(/ownership/);
    bounded.retire();
    if (process.env.PI_TODO_PERF_REPORT)
      writeFileSync(
        process.env.PI_TODO_PERF_REPORT,
        JSON.stringify(
          {
            version: VERSION,
            gc: !!global.gc,
            bodies: 192 * 64 * 1024,
            rows,
            afterRetireHeap: retained.heapUsed,
            afterRetireRss: retained.rss,
          },
          null,
          2,
        ),
      );
  } finally {
    store.retire();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

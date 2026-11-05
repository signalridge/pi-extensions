import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Snapshot, STATE_TYPE } from "../src/state.js";
import { TodoStore } from "../src/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(nativeData?: { data: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), "todo-cache-security-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(1024 * 1024) }], timestamp: 1 });
  if (nativeData) manager.appendCustomEntry("unrelated", nativeData);
  const ctx = { sessionManager: manager } as unknown as ExtensionContext;
  const append = vi.fn((type: string, data: unknown) => {
    manager.appendCustomEntry(type, data);
  });
  const store = new TodoStore({ appendEntry: append });
  store.reconcile(ctx);
  const snapshot = store.mutate(ctx, { action: "add", baseRevision: 0, title: "Durable" });
  store.read(ctx);
  const entry = manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === STATE_TYPE);
  if (entry?.type !== "custom") throw new Error("Missing state");
  const ordinary = manager.getBranch().find((entry) => entry.type === "message");
  if (ordinary?.type !== "message" || ordinary.message.role !== "user" || !Array.isArray(ordinary.message.content))
    throw new Error("Missing native message blocks");
  return { manager, ctx, append, store, snapshot, data: entry.data as Snapshot, content: ordinary.message.content };
}

describe("warm memo cannot confer stale native authority", () => {
  for (const operation of ["read", "mutation"] as const) {
    for (const direction of ["plain to raw", "raw to plain"] as const) {
      it.each(["1", "true", "null", '"raw 😀"'])(
        `rejects native ${direction} JSON %s on a warm ${operation} without appending`,
        (text) => {
          const nativeJSON = JSON as typeof JSON & { rawJSON(text: string): object };
          const raw = nativeJSON.rawJSON(text);
          const plain: object = Object.create(Object.getPrototypeOf(raw));
          Object.defineProperties(plain, Object.getOwnPropertyDescriptors(raw));
          const nativeData = { data: direction === "plain to raw" ? plain : raw };
          const before = JSON.stringify(nativeData);
          const f = fixture(nativeData);
          nativeData.data = direction === "plain to raw" ? raw : plain;
          expect(JSON.stringify(nativeData)).not.toBe(before);
          const attempt = () =>
            operation === "read" ? f.store.read(f.ctx) : f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 });
          expect(attempt).toThrow(/ownership/);
          expect(f.append).toHaveBeenCalledOnce();
        },
      );
    }
    it(`rejects an altered dependency array on a warm ${operation} without appending`, () => {
      const f = fixture();
      f.data.tasks[0].dependencies = Object.create(Array.prototype);
      const attempt = () =>
        operation === "read" ? f.store.read(f.ctx) : f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 });
      expect(attempt).toThrow(/ownership/);
      expect(f.append).toHaveBeenCalledOnce();
    });
    it.each(["array kind", "boxed Boolean", "boxed Number"])(
      `rejects an altered native-prefix %s on a warm ${operation} without appending`,
      (change) => {
        const nativeData: { data: unknown } = { data: change === "array kind" ? [] : {} };
        const f = fixture(nativeData);
        nativeData.data =
          change === "array kind"
            ? Object.create(Array.prototype)
            : Object.setPrototypeOf(Object(change === "boxed Boolean" ? true : 7), Object.prototype);
        const attempt = () =>
          operation === "read" ? f.store.read(f.ctx) : f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 });
        expect(attempt).toThrow(/ownership/);
        expect(f.append).toHaveBeenCalledOnce();
      },
    );
  }
  it.each(["revision", "schema", "status", "description", "length", "dependency"])(
    "rejects a same-ID in-place %s change",
    (field) => {
      const f = fixture();
      if (field === "revision") f.data.revision++;
      if (field === "schema") Object.assign(f.data, { schemaVersion: 2 });
      if (field === "status") f.data.tasks[0].status = "completed";
      if (field === "description") f.data.tasks[0].description = "Added field";
      if (field === "length") f.data.tasks.length = 0;
      if (field === "dependency") f.data.tasks[0].dependencies.push(f.data.tasks[0].id);
      expect(() => f.store.read(f.ctx)).toThrow(/ownership/);
      expect(() => f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 })).toThrow(/ownership/);
      expect(f.append).toHaveBeenCalledOnce();
    },
  );
  it.each(["deep value", "array length", "index", "prototype"])(
    "rejects a warm ordinary ancestor %s change",
    (change) => {
      const f = fixture();
      if (change === "deep value") Object.assign(f.content[0], { text: "Altered" });
      if (change === "array length") f.content.length = 0;
      if (change === "index") f.content[0] = { type: "text", text: "Replacement" };
      if (change === "prototype")
        Object.setPrototypeOf(f.content[0], { toJSON: () => ({ type: "text", text: "Override" }) });
      expect(() => f.store.read(f.ctx)).toThrow(/ownership/);
      expect(() => f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 })).toThrow(/ownership/);
      expect(f.append).toHaveBeenCalledOnce();
    },
  );
  it("validates both sides of disk inspection, including an unchanged cached file identity", () => {
    const f = fixture();
    const nativeStat = fs.statSync;
    let changed = false;
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      const result = nativeStat(...args);
      if (!changed) {
        changed = true;
        Object.assign(f.content[0], { text: "Changed during disk proof" });
      }
      return result;
    });
    syncBuiltinESMExports();
    expect(() => f.store.read(f.ctx)).toThrow(/unavailable/);
    expect(changed).toBe(true);
    expect(f.store.isUnavailable).toBe(true);
  });
  it("rejects native tampering during preflight disk verification before any append", () => {
    const f = fixture();
    const nativeStat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      const result = nativeStat(...args);
      f.data.tasks[0].title = "Tampered during preflight";
      return result;
    });
    syncBuiltinESMExports();
    expect(() => f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 })).toThrow(
      /ownership changed during preflight/i,
    );
    expect(f.append).toHaveBeenCalledOnce(); // Only the fixture's initial verified mutation.
  });
  it("keeps pre-write and post-write native checks fresh with warm fingerprints", () => {
    const f = fixture();
    f.append.mockImplementationOnce((type, data) => {
      f.manager.appendCustomEntry(type, data);
      Object.assign(f.content[0], { text: "Tampered inside native append" });
    });
    expect(() => f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 })).toThrow(
      /ownership changed during persistence/i,
    );
    expect(f.store.isUnavailable).toBe(true);
    expect(() => f.store.read(f.ctx)).toThrow(/ownership/);
  });
  it("does not serialize unchanged huge native values on a warm disk-backed read", () => {
    const f = fixture();
    const original = JSON.stringify;
    let largeBytes = 0;
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const serialized = original(...args);
      if (serialized && serialized.length > 128 * 1024) largeBytes += Buffer.byteLength(serialized);
      return serialized;
    });
    expect(f.store.read(f.ctx)).toEqual(f.snapshot);
    expect(f.store.read(f.ctx)).toEqual(f.snapshot);
    stringify.mockRestore();
    expect(largeBytes).toBe(0);
  });
});

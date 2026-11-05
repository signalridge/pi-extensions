import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { CanonicalFingerprints } from "../src/canonical-fingerprint.js";
import { PLAN_HANDOFF_IDENTITY_ENTRY, PlanInputOwnership } from "../src/input-ownership.js";

function fixture() {
  const manager = SessionManager.inMemory(process.cwd());
  const ctx = { sessionManager: manager } as ExtensionContext;
  const cache = new CanonicalFingerprints();
  const ownership = new PlanInputOwnership(
    (data) => manager.appendCustomEntry(PLAN_HANDOFF_IDENTITY_ENTRY, data),
    cache,
  );
  const accept = (text: string, source = "rpc") => {
    ownership.input({ text, source }, ctx, 1);
    const native = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 100 };
    ownership.message(native, ctx, 1);
    manager.appendMessage(native);
    return native;
  };
  return { manager, ctx, cache, ownership, accept };
}

for (const change of ["nested", "delete", "append", "truncate", "reorder", "role", "string"] as const) {
  test(`same-ID/same-object prefix ${change} invalidates warm native revision and one-use ticket`, () => {
    const f = fixture();
    const content = [
      { type: "text" as const, text: "first" },
      { type: "text" as const, text: "second" },
    ];
    f.manager.appendMessage({ role: "user", content, timestamp: 1 });
    const native = f.accept("revise");
    expect(f.ownership.authorized(f.ctx, 1)).toBe(true);
    expect(f.ownership.authorizeCall("ticket", f.ctx, 1)).toBe(true);
    const entry = f.manager.getBranch()[0];
    const id = entry.id;
    if (entry.type !== "message") throw new Error("missing prefix message");
    if (change === "nested") content[0].text = "changed";
    if (change === "delete") Reflect.deleteProperty(content[0], "text");
    if (change === "append") content.push({ type: "text", text: "third" });
    if (change === "truncate") content.length = 1;
    if (change === "reorder") content.reverse();
    if (change === "role") Reflect.set(entry.message, "role", "assistant");
    if (change === "string") Reflect.set(entry.message, "content", "replacement");
    expect(f.manager.getBranch()[0]).toBe(entry);
    expect(entry.id).toBe(id);
    expect(native.content[0].text).toBe("revise");
    expect(f.ownership.consumeCall("ticket", f.ctx, 1)).toBe(false);
    expect(f.ownership.authorized(f.ctx, 1)).toBe(false);
    expect(f.ownership.revisionStarted(f.ctx, 1)).toBe(false);
  });
}

for (const [name, before, after] of [
  ["boxed Boolean", {}, Object.setPrototypeOf(new Boolean(true), Object.prototype)],
  ["boxed Number", {}, Object.setPrototypeOf(new Number(2), Object.prototype)],
  ["boxed String", {}, Object.setPrototypeOf(new String("changed"), Object.prototype)],
  ["array-prototype impostor", [], Object.create(Array.prototype)],
] as const) {
  test(`same-ID opaque prefix replacement with ${name} revokes warm native authority and ticket`, () => {
    const f = fixture();
    const prefix: { data: unknown } = { data: before };
    f.manager.appendCustomEntry("opaque-prefix", prefix);
    const entry = f.manager.getBranch()[0];
    const id = entry.id;
    f.accept("revise");
    expect(f.ownership.authorized(f.ctx, 1)).toBe(true);
    expect(f.ownership.authorizeCall("ticket", f.ctx, 1)).toBe(true);
    prefix.data = after;
    expect(f.manager.getBranch()[0]).toBe(entry);
    expect(entry.id).toBe(id);
    expect(f.ownership.consumeCall("ticket", f.ctx, 1)).toBe(false);
    expect(f.ownership.authorized(f.ctx, 1)).toBe(false);
    expect(f.ownership.revisionStarted(f.ctx, 1)).toBe(false);
  });
}

const nativeJSON = JSON as typeof JSON & { rawJSON(text: string): object };
for (const payload of ['"text"', "1", "null"]) {
  for (const reverse of [false, true]) {
    test.skipIf(typeof nativeJSON.rawJSON !== "function")(
      `same-ID RawJSON ${payload} prefix replacement revokes warm authority and ticket (reverse=${reverse})`,
      () => {
        const f = fixture();
        const raw = nativeJSON.rawJSON(payload);
        const plain = Object.create(Object.getPrototypeOf(raw), Object.getOwnPropertyDescriptors(raw));
        const prefix = { data: reverse ? raw : plain };
        f.manager.appendCustomEntry("opaque-prefix", prefix);
        const entry = f.manager.getBranch()[0];
        const id = entry.id;
        f.accept("revise");
        expect(f.ownership.authorized(f.ctx, 1)).toBe(true);
        expect(f.ownership.authorizeCall("ticket", f.ctx, 1)).toBe(true);
        prefix.data = reverse ? plain : raw;
        expect(f.manager.getBranch()[0]).toBe(entry);
        expect(entry.id).toBe(id);
        expect(f.ownership.consumeCall("ticket", f.ctx, 1)).toBe(false);
        expect(f.ownership.authorized(f.ctx, 1)).toBe(false);
        expect(f.ownership.revisionStarted(f.ctx, 1)).toBe(false);
      },
    );
  }
}

test("same-object accepted block overwrite never reuses native or branch fingerprints", () => {
  const f = fixture();
  const native = f.accept("original");
  expect(f.ownership.authorizeCall("ticket", f.ctx, 1)).toBe(true);
  native.content[0].text = "forged";
  expect(f.ownership.consumeCall("ticket", f.ctx, 1)).toBe(false);
  expect(f.ownership.authorized(f.ctx, 1)).toBe(false);
});

test("deep opaque metadata mutation invalidates prefix proof; ordinary append/compaction do not", () => {
  const f = fixture();
  const opaque = { payload: { values: ["opaque", "unchanged"] } };
  f.manager.appendCustomEntry("unrelated-opaque", opaque);
  f.accept("original");
  expect(f.ownership.authorized(f.ctx, 1)).toBe(true);
  f.manager.appendCustomEntry("ordinary-append", { value: 1 });
  f.manager.appendCompaction("synthetic summary", f.manager.getLeafId(), 1);
  expect(f.ownership.authorized(f.ctx, 1)).toBe(true);
  opaque.payload.values[1] = "mutated";
  expect(f.ownership.authorized(f.ctx, 1)).toBe(false);
});

test("retired opaque provenance is branch-local and metadata mutation cannot inherit it", () => {
  const f = fixture();
  const prefix = { nested: { value: "before" } };
  f.manager.appendCustomEntry("opaque-prefix", prefix);
  const transport = f.ownership.send("owned handoff", { implementationId: "old" }, f.ctx, 1);
  f.ownership.input({ text: transport, source: "extension" }, f.ctx, 1);
  f.ownership.reset();
  const native = { role: "user" as const, content: [{ type: "text" as const, text: transport }], timestamp: 100 };
  expect(f.ownership.message(native, f.ctx, 2)).toEqual({ retired: true });
  f.manager.appendMessage(native);
  expect(f.ownership.context([native], f.ctx, 2)[0].content).toEqual([]);
  prefix.nested.value = "different prefix";
  expect(f.ownership.context([native], f.ctx, 2)[0]).toBe(native);
  expect(f.ownership.authorized(f.ctx, 2)).toBe(false);
});

test("an appendIdentity callback that mutates the prefix is rechecked before the next native commit", () => {
  const manager = SessionManager.inMemory(process.cwd());
  const ctx = { sessionManager: manager } as ExtensionContext;
  const prefix = { nested: { value: "original" } };
  manager.appendCustomEntry("opaque", prefix);
  let callbacks = 0;
  const ownership = new PlanInputOwnership((data) => {
    callbacks++;
    manager.appendCustomEntry(PLAN_HANDOFF_IDENTITY_ENTRY, data);
    prefix.nested.value = "changed by callback";
  });
  for (let index = 0; index < 2; index++) {
    const text = ownership.send(`handoff-${index}`, { implementationId: `implementation-${index}` }, ctx, 1);
    ownership.input({ text, source: "extension" }, ctx, 1);
    const native = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: index + 1 };
    ownership.message(native, ctx, 1);
    // Both are accepted before either native is committed.
    manager.appendCustomEntry("held-native", { native });
  }
  const held = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "held-native");
  for (const entry of held) {
    if (entry.type === "custom")
      manager.appendMessage((entry.data as { native: Parameters<typeof manager.appendMessage>[0] }).native);
  }
  ownership.commitHandoffs(ctx, 1);
  expect(callbacks).toBe(1);
  expect(
    manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === PLAN_HANDOFF_IDENTITY_ENTRY),
  ).toHaveLength(1);
});

test("retirement clears fingerprint retention without releasing old token rejection", () => {
  const f = fixture();
  f.manager.appendCustomEntry("opaque", { text: "synthetic".repeat(1000) });
  const text = f.ownership.send("handoff", { revision: true }, f.ctx, 1);
  expect(f.cache.retention.entries).toBeGreaterThan(0);
  f.ownership.reset();
  expect(f.cache.retention).toEqual({ entries: 0, bytes: 0, nodes: 0 });
  expect(f.ownership.input({ text, source: "extension" }, f.ctx, 2)).toEqual({ action: "handled" });
});

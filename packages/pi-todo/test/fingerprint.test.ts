import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FINGERPRINT_LIMITS, Fingerprints, fingerprint } from "../src/fingerprint.js";

const canonical = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nativeJSON = JSON as typeof JSON & { rawJSON(text: string): object; isRawJSON(value: unknown): boolean };
function rawPair(text: string) {
  const raw = nativeJSON.rawJSON(text);
  const plain: object = Object.create(Object.getPrototypeOf(raw));
  Object.defineProperties(plain, Object.getOwnPropertyDescriptors(raw));
  expect(nativeJSON.isRawJSON(raw)).toBe(true);
  expect(nativeJSON.isRawJSON(plain)).toBe(false);
  return { raw, plain };
}
function canonicalResult(value: unknown) {
  try {
    return { hash: canonical(value) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error };
  }
}
function parity(cache: Fingerprints, value: unknown) {
  expect(cache.hash(value)).toBe(canonical(value));
  expect(cache.hash(value)).toBe(canonical(value));
}

describe("bounded value-validated canonical fingerprints", () => {
  it("reuses unchanged megabyte strings without serializing them or owning the native objects", () => {
    const cache = new Fingerprints();
    const value = {
      id: "same",
      details: undefined,
      message: { content: [{ type: "text", text: "x".repeat(1024 * 1024) }] },
    };
    const expected = canonical(value);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(cache.hash(value)).toBe(expected);
      expect(cache.hash(value)).toBe(expected);
      expect(cache.hash(value)).toBe(expected);
      expect(stringify).toHaveBeenCalledOnce();
      expect(cache.usage.entries).toBe(1);
      expect(cache.usage.bytes).toBeGreaterThan(2 * 1024 * 1024);
    } finally {
      stringify.mockRestore();
    }
  });
  it("matches exact JSON.stringify order, Unicode, numeric keys and special leaf values", () => {
    const cache = new Fingerprints();
    for (const value of [
      null,
      false,
      0,
      -0,
      NaN,
      Infinity,
      "\ud800😀\u202e",
      [],
      {},
      { 10: "ten", 2: "two", a: "😀", b: [false, null, -0] },
      Object.assign(Object.create(null), { a: [1, 2] }),
      { missing: undefined },
      [undefined],
    ])
      parity(cache, value);
    expect(() => cache.hash(undefined)).toThrow();
    expect(() => fingerprint(undefined)).toThrow();
    expect(() => cache.hash(1n)).toThrow();
  });
  it("rejects same-ID deep edits, replacement values, key order/schema and prototype changes", () => {
    const cache = new Fingerprints();
    const value = { id: "same", data: { schemaVersion: 1, revision: 0, nested: { a: "old", b: "b" } } };
    parity(cache, value);
    value.data.nested.a = "new";
    parity(cache, value);
    value.data.nested = { a: "new", b: "changed" };
    parity(cache, value);
    value.data.nested = { b: "changed", a: "new" };
    parity(cache, value);
    value.data.schemaVersion = 2;
    parity(cache, value);
    Object.assign(value.data, { extra: true });
    parity(cache, value);
    Reflect.deleteProperty(value.data, "extra");
    parity(cache, value);
    Object.setPrototypeOf(value.data.nested, null);
    parity(cache, value);
    Object.setPrototypeOf(value.data.nested, { toJSON: () => "prototype override" });
    parity(cache, value);
  });
  it.each(["hash", "known"] as const)("%s rejects an array replaced by a non-array with Array.prototype", (method) => {
    const cache = new Fingerprints();
    const value: { data: unknown } = { data: [] };
    const before = cache.hash(value);
    expect(cache.known(value)).toBe(before);
    value.data = Object.create(Array.prototype);
    expect(canonical(value)).not.toBe(before);
    expect(cache[method](value)).toBe(method === "hash" ? canonical(value) : undefined);
  });
  for (const [kind, boxed] of [
    ["Boolean", () => Object(true)],
    ["Number", () => Object(7)],
    ["String", () => Object("")],
    ["BigInt", () => Object(1n)],
    ["Symbol", () => Object(Symbol("boxed"))],
  ] as const) {
    it.each(["hash", "known"] as const)(
      `%s rejects a plain object replaced by an altered-prototype boxed ${kind}`,
      (method) => {
        const cache = new Fingerprints();
        const value: { data: unknown } = { data: {} };
        const before = cache.hash(value);
        expect(cache.known(value)).toBe(before);
        value.data = Object.setPrototypeOf(boxed(), Object.prototype);
        const expected = canonicalResult(value);
        const stringify = vi.spyOn(JSON, "stringify");
        try {
          if (method === "known") {
            expect(cache.known(value)).toBeUndefined();
            expect(stringify).not.toHaveBeenCalled();
          } else {
            if (expected.error) expect(() => cache.hash(value)).toThrow(expected.error);
            else expect(cache.hash(value)).toBe(expected.hash);
            expect(stringify).toHaveBeenCalledOnce();
          }
        } finally {
          stringify.mockRestore();
        }
      },
    );
    it.each([Object.prototype, Array.prototype, null, Object.getPrototypeOf(boxed())])(
      `never captures boxed ${kind}, regardless of prototype (%#)`,
      (prototype) => {
        const cache = new Fingerprints();
        const value = { data: Object.setPrototypeOf(boxed(), prototype) };
        const expected = canonicalResult(value);
        const stringify = vi.spyOn(JSON, "stringify");
        try {
          if (expected.error) {
            expect(() => cache.hash(value)).toThrow(expected.error);
            expect(() => cache.hash(value)).toThrow(expected.error);
          } else {
            expect(cache.hash(value)).toBe(expected.hash);
            expect(cache.hash(value)).toBe(expected.hash);
          }
          expect(stringify).toHaveBeenCalledTimes(2);
          expect(cache.known(value)).toBeUndefined();
          expect(cache.usage.entries).toBe(0);
        } finally {
          stringify.mockRestore();
        }
      },
    );
  }
  for (const text of ["1", "true", "null", '"raw 😀"']) {
    it.each(["root", "nested"])(`never captures native raw JSON ${text} (%s)`, (location) => {
      const cache = new Fingerprints();
      const { raw } = rawPair(text);
      const value = location === "root" ? raw : { data: raw };
      const expected = canonical(value);
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        expect(cache.hash(value)).toBe(expected);
        expect(cache.hash(value)).toBe(expected);
        expect(stringify).toHaveBeenCalledTimes(2);
        expect(cache.known(value)).toBeUndefined();
        expect(stringify).toHaveBeenCalledTimes(2);
        expect(cache.usage.entries).toBe(0);
      } finally {
        stringify.mockRestore();
      }
    });
    for (const direction of ["plain to raw", "raw to plain"] as const) {
      it.each(["hash", "known"] as const)(`%s rejects warmed ${direction} JSON ${text}`, (method) => {
        const cache = new Fingerprints();
        const { raw, plain } = rawPair(text);
        const value = { data: direction === "plain to raw" ? plain : raw };
        const before = cache.hash(value);
        if (direction === "plain to raw") expect(cache.known(value)).toBe(before);
        value.data = direction === "plain to raw" ? raw : plain;
        const expected = canonical(value);
        expect(expected).not.toBe(before);
        const stringify = vi.spyOn(JSON, "stringify");
        try {
          expect(cache[method](value)).toBe(method === "hash" ? expected : undefined);
          expect(stringify).toHaveBeenCalledTimes(method === "hash" ? 1 : 0);
        } finally {
          stringify.mockRestore();
        }
      });
    }
  }
  it.each(["-0", "1e400"])("preserves raw JSON number spelling without parsing it (%s)", (text) => {
    const cache = new Fingerprints();
    const value = { data: nativeJSON.rawJSON(text) };
    expect(JSON.stringify(value)).toBe(`{"data":${text}}`);
    parity(cache, value);
    expect(cache.known(value)).toBeUndefined();
    expect(cache.usage.entries).toBe(0);
  });
  it.each([7, "boxed"])("preserves boxed coercion callbacks and thrown error identity (%s)", (primitive) => {
    const cache = new Fingerprints();
    const value: { data: unknown } = { data: {} };
    cache.hash(value);
    const box = Object.setPrototypeOf(Object(primitive), Object.prototype);
    value.data = box;
    let reads = 0;
    let calls = 0;
    const failure = new Error("boxed coercion failed");
    Object.defineProperty(box, Symbol.toPrimitive, {
      get() {
        reads++;
        return () => {
          if (++calls === 2) throw failure;
          return primitive;
        };
      },
    });
    expect(cache.known(value)).toBeUndefined();
    expect(reads).toBe(0);
    expect(cache.hash(value)).toBe(canonical({ data: primitive }));
    expect(reads).toBe(1);
    expect(calls).toBe(1);
    expect(cache.known(value)).toBeUndefined();
    expect(reads).toBe(1);
    let caught: unknown;
    try {
      cache.hash(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(reads).toBe(2);
    expect(calls).toBe(2);
    expect(cache.usage.entries).toBe(0);
  });
  it("checks every array length/index including holes, reorder, non-index properties and hidden keys", () => {
    const cache = new Fingerprints();
    const value = { data: [{ text: "A" }, { text: "B" }] };
    parity(cache, value);
    value.data[1].text = "deep edit";
    parity(cache, value);
    value.data.reverse();
    parity(cache, value);
    value.data.push({ text: "C" });
    parity(cache, value);
    value.data.length = 1;
    parity(cache, value);
    Reflect.deleteProperty(value.data, "0");
    parity(cache, value);
    value.data[0] = { text: "restored" };
    Object.assign(value.data, { extra: "ignored by JSON, not memoized" });
    parity(cache, value);
    Reflect.deleteProperty(value.data, "extra");
    Object.defineProperty(value.data[0], "text", { enumerable: false });
    parity(cache, value);
    Object.defineProperty(value.data, "0", { get: () => ({ text: "accessor index" }) });
    parity(cache, value);
  });
  it("falls back for getters/toJSON without executing them extra, even after a prior safe hit", () => {
    const cache = new Fingerprints();
    let reads = 0;
    const value = { data: { text: "plain" } };
    cache.hash(value);
    cache.hash(value);
    Object.defineProperty(value.data, "text", { get: () => `read-${++reads}`, enumerable: true });
    expect(cache.hash(value)).toBe(canonical({ data: { text: "read-1" } }));
    expect(reads).toBe(1);
    expect(cache.hash(value)).toBe(canonical({ data: { text: "read-2" } }));
    expect(reads).toBe(2);
    expect(cache.usage.entries).toBe(0);
    let calls = 0;
    const custom = { toJSON: () => ({ called: ++calls }) };
    expect(cache.hash(custom)).toBe(canonical({ called: 1 }));
    expect(calls).toBe(1);
    const inherited = Object.create({
      get toJSON() {
        calls++;
        return () => "inherited";
      },
    });
    expect(cache.hash(inherited)).toBe(canonical("inherited"));
    expect(calls).toBe(2);
  });
  it("does not add proxy traps, including nested/revoked proxies, exotic data or cycles", () => {
    const cache = new Fingerprints();
    const makeProxy = (log: string[]) =>
      new Proxy(
        { text: "x" },
        {
          get(target, key, receiver) {
            log.push(`get:${String(key)}`);
            return Reflect.get(target, key, receiver);
          },
          ownKeys(target) {
            log.push("keys");
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            log.push(`descriptor:${String(key)}`);
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
          getPrototypeOf(target) {
            log.push("prototype");
            return Reflect.getPrototypeOf(target);
          },
        },
      );
    for (const nested of [false, true]) {
      const before: string[] = [];
      const after: string[] = [];
      const original = makeProxy(before);
      const candidate = makeProxy(after);
      expect(cache.hash(nested ? { candidate } : candidate)).toBe(
        canonical(nested ? { candidate: original } : original),
      );
      expect(after).toEqual(before);
    }
    for (const value of [new Date(0), new Map([["x", 1]]), new Set([1]), new Uint8Array([1]), new Number(2)])
      parity(cache, value);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => cache.hash(revoked.proxy)).toThrow();
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => cache.hash(cycle)).toThrow();
    const warm: { data: unknown } = { data: { x: 1 } };
    cache.hash(warm);
    warm.data = warm;
    expect(() => cache.hash(warm)).toThrow();
  });
  it("notices inherited toJSON installed after warming without probing the getter", () => {
    const cache = new Fingerprints();
    const value = { a: "x" };
    cache.hash(value);
    let reads = 0;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        get() {
          reads++;
          return () => "changed";
        },
      });
      const result = cache.hash(value);
      const count = reads;
      Reflect.deleteProperty(Object.prototype, "toJSON");
      expect(result).toBe(canonical("changed"));
      expect(count).toBe(1);
    } finally {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }
  });
  it("offers disk hints only after current value validation, without hashing or executing unsafe data", () => {
    const cache = new Fingerprints();
    let reads = 0;
    const value = { data: { x: "before" } };
    expect(cache.known(value)).toBeUndefined();
    const hash = cache.hash(value);
    expect(cache.known(value)).toBe(hash);
    value.data.x = "after";
    expect(cache.known(value)).toBeUndefined();
    cache.hash(value);
    Object.defineProperty(value.data, "x", {
      get: () => {
        reads++;
        return "getter";
      },
    });
    expect(cache.known(value)).toBeUndefined();
    expect(reads).toBe(0);
    cache.clear();
    expect(cache.known(value)).toBeUndefined();
    expect(reads).toBe(0);
  });
  it("rechecks Array.prototype toJSON on every hit without extra getter execution", () => {
    const cache = new Fingerprints();
    const value = { data: [1, 2] };
    cache.hash(value);
    cache.hash(value);
    let reads = 0;
    const results: string[] = [];
    try {
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        get() {
          reads++;
          return () => "array override";
        },
      });
      results.push(cache.hash(value));
      results.push(cache.hash(value));
    } finally {
      Reflect.deleteProperty(Array.prototype, "toJSON");
    }
    expect(reads).toBe(2);
    expect(results).toEqual([canonical({ data: "array override" }), canonical({ data: "array override" })]);
  });
  it("falls back for sparse arrays, reading inherited indices/getters only as often as JSON.stringify", () => {
    const cache = new Fingerprints();
    const value = Array.from({ length: 8 }, (_, i) => i);
    cache.hash(value);
    cache.hash(value);
    Reflect.deleteProperty(value, "7");
    let reads = 0;
    let first = "";
    let second = "";
    try {
      Object.defineProperty(Array.prototype, "7", {
        configurable: true,
        get() {
          return `inherited-${++reads}`;
        },
      });
      first = cache.hash(value);
      second = cache.hash(value);
    } finally {
      Reflect.deleteProperty(Array.prototype, "7");
    }
    expect(reads).toBe(2);
    expect(first).toBe(canonical([0, 1, 2, 3, 4, 5, 6, "inherited-1"]));
    expect(second).toBe(canonical([0, 1, 2, 3, 4, 5, 6, "inherited-2"]));
    expect(cache.usage.entries).toBe(0);
  });
  for (const index of ["0", "7"])
    it.each(["Array", "Object"])(
      `does not execute inherited %s numeric accessors at ${index} while capturing, matching or invalidating metadata`,
      (prototype) => {
        const cache = new Fingerprints();
        const value = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 };
        const expected = canonical(value);
        const changed = canonical({ ...value, a: 10 });
        const target = prototype === "Array" ? Array.prototype : Object.prototype;
        let access = 0;
        let first = "";
        let second = "";
        let known: string | undefined;
        let invalidated: string | undefined;
        let third = "";
        try {
          Object.defineProperty(target, index, {
            configurable: true,
            get() {
              access++;
              return "unexpected";
            },
            set() {
              access++;
            },
          });
          first = cache.hash(value);
          second = cache.hash(value);
          known = cache.known(value);
          value.a = 10;
          invalidated = cache.known(value);
          third = cache.hash(value);
          cache.clear();
        } finally {
          Reflect.deleteProperty(target, index);
        }
        expect(first).toBe(expected);
        expect(second).toBe(expected);
        expect(known).toBe(expected);
        expect(invalidated).toBeUndefined();
        expect(third).toBe(changed);
        expect(access).toBe(0);
      },
    );
  it("preserves function/toJSON and throwing-getter failures and side-effect counts", () => {
    const cache = new Fingerprints();
    expect(() => cache.hash(() => "not JSON")).toThrow();
    let reads = 0;
    const callable = Object.assign(() => 0, {
      toJSON: () => {
        reads++;
        return "callable";
      },
    });
    expect(cache.hash(callable)).toBe(canonical("callable"));
    expect(reads).toBe(1);
    const failure = new Error("getter failed");
    const value = {
      get field() {
        reads++;
        throw failure;
      },
    };
    let caught: unknown;
    try {
      cache.hash(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(reads).toBe(2);
  });
  it("bounds entries, retained value bytes, nodes and per-entry depth; eviction confers no proof", () => {
    const cache = new Fingerprints();
    const oldest = { id: "old", data: "before" };
    cache.hash(oldest);
    for (let i = 0; i < FINGERPRINT_LIMITS.entries + 10; i++) cache.hash({ id: i });
    expect(cache.usage.entries).toBeLessThanOrEqual(FINGERPRINT_LIMITS.entries);
    oldest.data = "changed while evicted";
    parity(cache, oldest);
    const wide = { items: Array.from({ length: 2000 }, (_, i) => ({ i })) };
    parity(cache, wide);
    cache.clear();
    for (let i = 0; i < 40; i++) {
      parity(cache, { id: i, text: "x".repeat(512 * 1024) });
      expect(cache.usage.bytes).toBeLessThanOrEqual(FINGERPRINT_LIMITS.bytes);
      expect(cache.usage.nodes).toBeLessThanOrEqual(FINGERPRINT_LIMITS.nodes);
    }
    expect(cache.usage.bytes).toBeGreaterThan(FINGERPRINT_LIMITS.bytes / 2);
    cache.clear();
    for (let i = 0; i < 40; i++) {
      parity(cache, { values: Array.from({ length: 1024 }, (_, n) => n + i) });
      expect(cache.usage.nodes).toBeLessThanOrEqual(FINGERPRINT_LIMITS.nodes);
    }
    expect(cache.usage.nodes).toBeGreaterThan(FINGERPRINT_LIMITS.nodes / 2);
    const huge = { text: "x".repeat(FINGERPRINT_LIMITS.bytes) };
    parity(cache, huge);
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) deep = { deep };
    parity(cache, deep);
    cache.clear();
    expect(cache.usage).toEqual({ entries: 0, bytes: 0, nodes: 0 });
    parity(cache, oldest);
  });
});

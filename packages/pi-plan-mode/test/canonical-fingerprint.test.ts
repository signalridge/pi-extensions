import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { CanonicalFingerprints, canonicalContentKey, canonicalEntryKey } from "../src/canonical-fingerprint.js";

function memo(limits: ConstructorParameters<typeof CanonicalFingerprints>[0] = {}) {
  const hash = vi.fn(canonicalContentKey);
  return { hash, cache: new CanonicalFingerprints(limits, hash) };
}

const mutations: Array<[string, (value: Record<string, unknown>) => void]> = [
  [
    "nested same-object text overwrite",
    (value) => {
      (value.content as Array<{ text: string }>)[0].text = "forged";
    },
  ],
  [
    "block deletion",
    (value) => {
      delete (value.content as Array<Record<string, unknown>>)[0].text;
    },
  ],
  [
    "block append",
    (value) => {
      (value.content as unknown[]).push({ type: "text", text: "extra" });
    },
  ],
  [
    "array truncation",
    (value) => {
      (value.content as unknown[]).length = 0;
    },
  ],
  [
    "array reorder",
    (value) => {
      (value.content as unknown[]).reverse();
    },
  ],
  [
    "array hole",
    (value) => {
      delete (value.content as unknown[])[0];
    },
  ],
  [
    "role overwrite",
    (value) => {
      value.role = "assistant";
    },
  ],
  [
    "same-ID metadata overwrite",
    (value) => {
      (value.metadata as { branch: string }).branch = "other";
    },
  ],
  [
    "metadata deletion",
    (value) => {
      delete value.metadata;
    },
  ],
  [
    "key reorder",
    (value) => {
      const role = value.role;
      delete value.role;
      value.role = role;
    },
  ],
  [
    "enumerability change",
    (value) => {
      Object.defineProperty(value, "role", { enumerable: false });
    },
  ],
  [
    "string to array",
    (value) => {
      (value.content as Array<{ text: unknown }>)[0].text = ["original"];
    },
  ],
];

for (const [name, mutate] of mutations) {
  test(`a warmed same-ID/same-object fingerprint detects ${name}`, () => {
    const { cache, hash } = memo();
    const value = {
      id: "unchanged",
      role: "user",
      content: [
        { type: "text", text: "original" },
        { type: "text", text: "second" },
      ],
      metadata: { branch: "original" },
    };
    const first = cache.key(value);
    expect(cache.key(value)).toBe(first);
    expect(hash).toHaveBeenCalledTimes(1);
    mutate(value);
    const next = cache.key(value);
    expect(next).toBe(canonicalContentKey(value));
    expect(next).not.toBe(first);
    expect(hash).toHaveBeenCalledTimes(2);
  });
}

test("raw equality, not equal serialization or root/child identity, proves a hit", () => {
  const { cache, hash } = memo();
  const value = { data: { a: undefined, b: NaN, c: -0, text: "x".repeat(1024 * 1024) } };
  const first = cache.key(value);
  value.data = { ...value.data }; // structurally identical replacement is safe
  expect(cache.key(value)).toBe(first);
  expect(hash).toHaveBeenCalledTimes(1);
  value.data.b = Infinity; // same JSON (null), different raw value must miss
  expect(cache.key(value)).toBe(first);
  expect(hash).toHaveBeenCalledTimes(2);
  value.data.c = 0; // same JSON again
  expect(cache.key(value)).toBe(first);
  expect(hash).toHaveBeenCalledTimes(3);
  delete (value.data as { a?: unknown }).a; // omitted fields are still validated
  expect(cache.key(value)).toBe(first);
  expect(hash).toHaveBeenCalledTimes(4);
});

test("canonical output includes exact property order, escaping and undefined semantics", () => {
  for (const value of [
    undefined,
    null,
    '\ud800\n"\\',
    -0,
    NaN,
    { z: 0, "2": 2, "1": 1, a: "😀", omitted: undefined },
    [undefined, NaN],
    Object.assign(Object.create(null), { a: 1 }),
  ]) {
    const { cache } = memo();
    const expected = createHash("sha256")
      .update(JSON.stringify(value) ?? "undefined")
      .digest("hex");
    expect(cache.key(value)).toBe(expected);
    expect(cache.key(value)).toBe(expected);
  }
  const undefinedJSON = { toJSON: () => undefined };
  const cache = new CanonicalFingerprints();
  expect(cache.key(undefinedJSON)).toBe(canonicalContentKey(undefined));
  expect(() => cache.key(undefinedJSON, canonicalEntryKey)).toThrow(TypeError);
});

const exoticFactories: Array<[string, () => unknown]> = [
  ["Date", () => ({ value: new Date(0) })],
  ["Map", () => ({ value: new Map([["key", 1]]) })],
  ["boxed scalar", () => ({ value: new Number(2) })],
  ["typed array", () => ({ value: new Uint8Array([1, 2]) })],
  ["custom prototype", () => Object.assign(Object.create({ inherited: 1 }), { value: 1 })],
  ["function", () => ({ value: () => 1 })],
  ["symbol", () => ({ value: Symbol("value") })],
  ["symbol key", () => ({ [Symbol("key")]: 1, value: 1 })],
  ["sparse array", () => Object.assign(new Array(3), { 0: 1, 2: 3 })],
  ["array extra properties", () => Object.assign([1], { extra: 2 })],
  ["toJSON", () => ({ toJSON: () => ({ value: 2 }) })],
];
for (const [name, factory] of exoticFactories) {
  test(`${name} always uses original canonical semantics, never a cached hash`, () => {
    const { cache, hash } = memo();
    const value = factory();
    for (let index = 0; index < 3; index++) expect(cache.key(value)).toBe(canonicalContentKey(value));
    expect(hash).toHaveBeenCalledTimes(3);
    expect(cache.retention).toEqual({ entries: 1, nodes: 0, bytes: 256 });
  });
}

test("accessors, toJSON and Proxy callbacks run exactly as often/in the order of original stringify", () => {
  for (const kind of ["accessor", "toJSON", "proxy", "nestedProxy", "hiddenAccessor"]) {
    const make = () => {
      const trace: string[] = [];
      const raw = {
        get value() {
          trace.push("getter");
          return trace.length;
        },
      };
      const proxy = new Proxy(raw, {
        get(target, key, receiver) {
          trace.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        getPrototypeOf(target) {
          trace.push("prototype");
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trace.push("keys");
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          trace.push(`descriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const value =
        kind === "proxy"
          ? proxy
          : kind === "nestedProxy"
            ? { data: proxy }
            : kind === "toJSON"
              ? {
                  get toJSON() {
                    trace.push("toJSON-getter");
                    return () => {
                      trace.push("toJSON-call");
                      return trace.length;
                    };
                  },
                }
              : kind === "hiddenAccessor"
                ? Object.defineProperty({}, "hidden", {
                    get() {
                      throw new Error("extra getter");
                    },
                  })
                : raw;
      return { trace, value };
    };
    const control = make();
    const candidate = make();
    const { cache } = memo();
    for (let index = 0; index < 3; index++) {
      expect(cache.key(candidate.value)).toBe(canonicalContentKey(control.value));
      expect(candidate.trace).toEqual(control.trace);
    }
  }
});

test("a formerly safe warm object cannot hide new accessors, toJSON, proxies, cycles or exotic prototypes", () => {
  const transforms: Array<(value: { data: unknown }) => void> = [
    (value) => {
      Object.defineProperty(value, "data", { get: () => "changed" });
    },
    (value) => {
      Object.assign(value, { toJSON: () => "changed" });
    },
    (value) => {
      value.data = new Proxy({ text: "changed" }, {});
    },
    (value) => {
      Object.setPrototypeOf(value, { toJSON: () => "changed" });
    },
    (value) => {
      value.data = value;
    },
    (value) => {
      value.data = 1n;
    },
  ];
  for (const transform of transforms) {
    const { cache, hash } = memo();
    const value = { data: { text: "original" } };
    cache.key(value);
    cache.key(value);
    expect(hash).toHaveBeenCalledTimes(1);
    transform(value);
    let expected: string;
    try {
      expected = canonicalContentKey(value);
    } catch (error) {
      expect(() => cache.key(value)).toThrow((error as Error).constructor);
      expect(cache.retention.nodes).toBe(0);
      continue;
    }
    expect(cache.key(value)).toBe(expected);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(cache.retention.nodes).toBe(0);
  }
});

test("revoked proxies and throwing raw getters/toJSON retain the original failure without extra calls", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const { cache } = memo();
  expect(() => cache.key(revoked.proxy)).toThrow(TypeError);
  expect(() => cache.key(revoked.proxy)).toThrow(TypeError);
  for (const property of ["content", "toJSON"]) {
    let calls = 0;
    const failure = new Error("original raw callback failure");
    const value = Object.defineProperty({}, property, {
      enumerable: true,
      get() {
        calls++;
        throw failure;
      },
    });
    for (let index = 0; index < 2; index++) expect(() => cache.key(value)).toThrow(failure);
    expect(calls).toBe(2);
  }
});

test("shared child graphs are validated by values at every path, not mistaken for cycles or immutable identities", () => {
  const { cache, hash } = memo();
  const child = { content: [{ text: "original" }] };
  const root = { left: child, right: child };
  const first = cache.key(root);
  expect(cache.key(root)).toBe(first);
  expect(hash).toHaveBeenCalledTimes(1);
  child.content[0].text = "changed through alias";
  expect(cache.key(root)).toBe(canonicalContentKey(root));
  expect(hash).toHaveBeenCalledTimes(2);
  expect(cache.key(root)).not.toBe(first);
});

test("prototype toJSON/accessor additions invalidate warm ordinary objects and arrays without extra reads", () => {
  for (const prototype of [Object.prototype, Array.prototype]) {
    const { cache, hash } = memo();
    const value = { data: ["original"] };
    cache.key(value);
    let calls = 0;
    Object.defineProperty(prototype, "toJSON", {
      configurable: true,
      get() {
        calls++;
        return () => "changed";
      },
    });
    try {
      expect(cache.key(value)).toBe(canonicalContentKey(value));
      expect(calls).toBe(2);
      expect(hash).toHaveBeenCalledTimes(2);
      expect(cache.retention.nodes).toBe(0);
    } finally {
      Reflect.deleteProperty(prototype, "toJSON");
    }
  }
});

test("a new array hole observes inherited numeric values/getters only through original stringify", () => {
  const { cache } = memo();
  const value = Array.from({ length: 1001 }, (_, index) => index);
  cache.key(value);
  delete value[500];
  let calls = 0;
  let inherited = "first";
  let first = "";
  let second = "";
  let expectedFirst = "";
  let expectedSecond = "";
  Object.defineProperty(Array.prototype, "500", {
    configurable: true,
    get() {
      calls++;
      return inherited;
    },
  });
  try {
    first = cache.key(value);
    expectedFirst = canonicalContentKey(value);
    inherited = "second";
    second = cache.key(value);
    expectedSecond = canonicalContentKey(value);
  } finally {
    Reflect.deleteProperty(Array.prototype, "500");
  }
  expect(first).toBe(expectedFirst);
  expect(second).toBe(expectedSecond);
  expect(first).not.toBe(second);
  expect(calls).toBe(4);
});

for (const prototype of [Array.prototype, Object.prototype]) {
  for (const index of ["0", "1"]) {
    test(`snapshot metadata never invokes inherited ${prototype === Array.prototype ? "Array" : "Object"}[${index}] accessors`, () => {
      const cache = new CanonicalFingerprints();
      const raw = { x: 1, y: { z: true } };
      const expected = canonicalContentKey(raw);
      let getters = 0;
      let setters = 0;
      let observed = "";
      Object.defineProperty(prototype, index, {
        configurable: true,
        get() {
          getters++;
          return undefined;
        },
        set(value: unknown) {
          setters++;
          Object.defineProperty(this, index, { configurable: true, enumerable: true, writable: true, value });
          // The vulnerable enumerable.push(true) changed raw after x's
          // descriptor was read: snapshot x=1, canonical hash x=2.
          if (value === true) raw.x = 2;
        },
      });
      try {
        observed = cache.key(raw);
      } finally {
        Reflect.deleteProperty(prototype, index);
      }
      raw.x = 1;
      expect(observed).toBe(expected);
      expect(cache.key(raw)).toBe(expected);
      expect(canonicalContentKey(raw)).toBe(expected);
      expect(getters).toBe(0);
      expect(setters).toBe(0);
    });
  }
}

for (const warm of [false, true]) {
  test(`descriptor metadata never reads an inherited value accessor or hides a raw accessor (warm=${warm})`, () => {
    const cache = new CanonicalFingerprints();
    let inheritedCalls = 0;
    let rawCalls = 0;
    const failure = new Error("canonical getter failure");
    const raw = { x: 1 };
    if (warm) cache.key(raw);
    Object.defineProperty(raw, "x", {
      enumerable: true,
      get() {
        rawCalls++;
        throw failure;
      },
    });
    let caught: unknown;
    Object.defineProperty(Object.prototype, "value", {
      configurable: true,
      get() {
        inheritedCalls++;
        return 1;
      },
    });
    try {
      try {
        cache.key(raw);
      } catch (error) {
        caught = error;
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, "value");
    }
    expect(caught).toBe(failure);
    expect(rawCalls).toBe(1);
    expect(inheritedCalls).toBe(0);
    expect(cache.retention.nodes).toBe(0);
  });
}

const nativeJSON = JSON as typeof JSON & {
  rawJSON(text: string): object;
  isRawJSON(value: unknown): boolean;
};
for (const payload of ['"text"', "1", "null"]) {
  test.skipIf(typeof nativeJSON.rawJSON !== "function")(
    `native RawJSON ${payload} always uses canonical fallback on cold capture`,
    () => {
      const raw = nativeJSON.rawJSON(payload);
      expect(nativeJSON.isRawJSON(raw)).toBe(true);
      for (const value of [raw, { data: raw }]) {
        const { cache, hash } = memo();
        for (let index = 0; index < 3; index++) expect(cache.key(value)).toBe(canonicalContentKey(value));
        expect(hash).toHaveBeenCalledTimes(3);
        expect(cache.fallbacks).toBe(3);
        expect(cache.retention.nodes).toBe(0);
      }
    },
  );
  for (const reverse of [false, true]) {
    test.skipIf(typeof nativeJSON.rawJSON !== "function")(
      `same-descriptor RawJSON ${payload} replacement preserves canonical identity (reverse=${reverse})`,
      () => {
        const raw = nativeJSON.rawJSON(payload);
        const plain = () => Object.create(Object.getPrototypeOf(raw), Object.getOwnPropertyDescriptors(raw));
        const { cache, hash } = memo();
        const value: { data: unknown } = { data: reverse ? raw : plain() };
        const first = cache.key(value);
        expect(cache.key(value)).toBe(first);
        if (!reverse) {
          value.data = plain(); // refresh the weak unboxed proof with a replacement
          expect(cache.key(value)).toBe(first);
          expect(hash).toHaveBeenCalledTimes(1);
        }
        value.data = reverse ? plain() : raw;
        const expected = canonicalContentKey(value);
        expect(expected).not.toBe(first);
        for (let index = 0; index < 2; index++) expect(cache.key(value)).toBe(expected);
        expect(hash).toHaveBeenCalledTimes(reverse ? 4 : 3);
        expect(cache.retention.nodes).toBe(0);
      },
    );
  }
}

test("the module loads and fingerprints ordinary data when RawJSON APIs are absent", () => {
  const moduleURL = new URL("../src/canonical-fingerprint.ts", import.meta.url).href;
  execFileSync("bun", [
    "--eval",
    `Reflect.deleteProperty(JSON, "rawJSON");
     Reflect.deleteProperty(JSON, "isRawJSON");
     const { CanonicalFingerprints, canonicalContentKey } = await import(${JSON.stringify(moduleURL)});
     const cache = new CanonicalFingerprints();
     const value = { data: { text: "ordinary" } };
     if (cache.key(value) !== canonicalContentKey(value) || cache.key(value) !== canonicalContentKey(value) || cache.fallbacks !== 0)
       throw new Error("missing RawJSON API changed ordinary fingerprinting");`,
  ]);
});

const boxedFactories = [
  ["Boolean", () => new Boolean(true)],
  ["Number", () => new Number(2)],
  ["String", () => new String("text")],
  ["BigInt", () => Object(1n)],
  ["Symbol", () => Object(Symbol("value"))],
] as const;
for (const [name, factory] of boxedFactories) {
  for (const prototype of [Object.prototype, null]) {
    test(`altered-prototype boxed ${name} always falls back on capture and warm matching (${prototype === null ? "null" : "Object"})`, () => {
      const boxed = Object.setPrototypeOf(factory(), prototype);
      // Match all own descriptors, including String indices and length, so
      // prototype/keys alone cannot distinguish plain data from native slots.
      const plain = Object.create(prototype, Object.getOwnPropertyDescriptors(boxed));
      const { cache, hash } = memo();
      const raw: { data: unknown } = { data: plain };
      cache.key(raw);
      cache.key(raw);
      expect(hash).toHaveBeenCalledTimes(1);
      raw.data = boxed;
      const outcome = (read: () => string) => {
        try {
          return { hash: read() };
        } catch (error) {
          return { error: { constructor: (error as Error).constructor, message: (error as Error).message } };
        }
      };
      const expected = outcome(() => canonicalContentKey(raw));
      for (let index = 0; index < 2; index++) expect(outcome(() => cache.key(raw))).toEqual(expected);
      expect(hash).toHaveBeenCalledTimes(3);
      expect(cache.retention.nodes).toBe(0);
      cache.clear();
      for (let index = 0; index < 2; index++) expect(outcome(() => cache.key(raw))).toEqual(expected);
      expect(hash).toHaveBeenCalledTimes(5);
      expect(cache.retention.nodes).toBe(0);
    });
  }
}

test("boxed fallback preserves coercion getter/call counts and exact thrown errors", () => {
  for (const fail of [false, true]) {
    const make = () => {
      const trace: string[] = [];
      const failure = new Error("boxed coercion failure");
      const boxed = Object.setPrototypeOf(new Number(2), Object.prototype);
      Object.defineProperty(boxed, "valueOf", {
        get() {
          trace.push("valueOf-get");
          return () => {
            trace.push("valueOf-call");
            if (fail) throw failure;
            return 2;
          };
        },
      });
      return { raw: { data: boxed }, trace, failure };
    };
    const control = make();
    const candidate = make();
    const cache = new CanonicalFingerprints();
    for (let index = 0; index < 2; index++) {
      if (fail) {
        expect(() => canonicalContentKey(control.raw)).toThrow(control.failure);
        expect(() => cache.key(candidate.raw)).toThrow(candidate.failure);
      } else {
        expect(cache.key(candidate.raw)).toBe(canonicalContentKey(control.raw));
      }
      expect(candidate.trace).toEqual(control.trace);
    }
    expect(cache.retention.nodes).toBe(0);
  }
});

test("array-prototype impostors and altered-prototype arrays cannot reuse an opposite-kind snapshot", () => {
  for (const [before, after] of [
    [[], Object.create(Array.prototype)],
    [{}, Object.setPrototypeOf([], Object.prototype)],
  ]) {
    const { cache, hash } = memo();
    const raw = { data: before };
    const first = cache.key(raw);
    raw.data = after;
    expect(cache.key(raw)).toBe(canonicalContentKey(raw));
    expect(cache.key(raw)).not.toBe(first);
    expect(hash).toHaveBeenCalledTimes(3);
    expect(cache.retention.nodes).toBe(0);
  }
});

test("negative hints never return a hash, and over-cap scans do not thrash all retained proofs", () => {
  const { cache, hash } = memo({ entries: 8 });
  const unsafeValue = { toJSON: () => "before" };
  const first = cache.key(unsafeValue);
  unsafeValue.toJSON = () => "after";
  expect(cache.key(unsafeValue)).not.toBe(first);
  expect(hash).toHaveBeenCalledTimes(2);
  cache.clear();
  const values = Array.from({ length: 20 }, (_, index) => ({ index }));
  for (const value of values) cache.key(value);
  const before = hash.mock.calls.length;
  for (const value of values) expect(cache.key(value)).toBe(canonicalContentKey(value));
  expect(hash.mock.calls.length - before).toBeLessThan(values.length);
  expect(cache.retention.entries).toBeLessThanOrEqual(8);
});

test("entry/node/byte/depth bounds evict or fall back without changing canonical identity", () => {
  const { cache, hash } = memo({ entries: 2, bytes: 2048, nodes: 16, depth: 4 });
  const a = { text: "a" };
  const b = { text: "b" };
  const c = { text: "c" };
  cache.key(a);
  cache.key(b);
  cache.key(a);
  cache.key(c);
  expect(cache.retention.entries).toBe(2);
  expect(hash).toHaveBeenCalledTimes(3);
  cache.key(b);
  expect(hash).toHaveBeenCalledTimes(4);
  for (const value of [
    { text: "x".repeat(2048) },
    { data: Array.from({ length: 30 }, (_, index) => index) },
    { a: { b: { c: { d: { e: 1 } } } } },
  ]) {
    expect(cache.key(value)).toBe(canonicalContentKey(value));
    expect(cache.key(value)).toBe(canonicalContentKey(value));
    expect(cache.retention.entries).toBeLessThanOrEqual(2);
    expect(cache.retention.bytes).toBeLessThanOrEqual(2048);
    expect(cache.retention.nodes).toBeLessThanOrEqual(16);
  }
  cache.clear();
  expect(cache.retention).toEqual({ entries: 0, bytes: 0, nodes: 0 });
  const before = hash.mock.calls.length;
  cache.key(b);
  expect(hash).toHaveBeenCalledTimes(before + 1);
});

test("cached snapshots do not retain raw object graphs across garbage collection", () => {
  const output = execFileSync("bun", [fileURLToPath(new URL("./fingerprint-gc.fixture.mjs", import.meta.url))], {
    encoding: "utf8",
  });
  expect(output.trim()).toBe("weak roots collected; bounded snapshots cleared");
});

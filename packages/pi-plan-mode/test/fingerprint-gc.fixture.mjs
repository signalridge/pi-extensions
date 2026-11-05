import assert from "node:assert/strict";
import { CanonicalFingerprints, canonicalContentKey } from "../src/canonical-fingerprint.ts";

const cache = new CanonicalFingerprints();
let weak;
function seed() {
  const root = { data: { text: "synthetic".repeat(10000) } };
  weak = new WeakRef(root);
  cache.key(root);
}
seed();
// WeakRefs are kept alive until the end of their current job. Yield jobs, not
// time/polling: this is a local GC fixture, no external completion to await.
await new Promise(setImmediate);
Bun.gc(true);
await new Promise(setImmediate);
Bun.gc(true);
assert.equal(weak.deref(), undefined);
assert.equal(cache.retention.entries, 1);
cache.clear();
assert.deepEqual(cache.retention, { entries: 0, bytes: 0, nodes: 0 });
// Exercise the safety-critical native APIs in the benchmark's Bun runtime,
// not just in Vitest's Node worker runtime.
let hashCalls = 0;
const native = new CanonicalFingerprints({}, (value) => {
  hashCalls++;
  return canonicalContentKey(value);
});
const mutable = { content: [{ text: "original" }] };
const original = native.key(mutable);
assert.equal(native.key(mutable), original);
assert.equal(hashCalls, 1);
mutable.content[0].text = "changed";
assert.notEqual(native.key(mutable), original);
assert.equal(hashCalls, 2);
let traps = 0;
const proxy = new Proxy(
  { text: "opaque" },
  {
    get(target, key, receiver) {
      traps++;
      return Reflect.get(target, key, receiver);
    },
    getPrototypeOf(target) {
      traps++;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      traps++;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      traps++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  },
);
canonicalContentKey(proxy);
const expectedTraps = traps;
traps = 0;
native.key(proxy);
assert.equal(traps, expectedTraps);
traps = 0;
native.key(proxy);
assert.equal(traps, expectedTraps);
const inherited = ["safe"];
native.key(inherited);
let toJSONCalls = 0;
Object.defineProperty(Array.prototype, "toJSON", {
  configurable: true,
  get() {
    toJSONCalls++;
    return () => "changed";
  },
});
let inheritedHash;
try {
  inheritedHash = native.key(inherited);
} finally {
  Reflect.deleteProperty(Array.prototype, "toJSON");
}
assert.equal(toJSONCalls, 1);
assert.equal(inheritedHash, canonicalContentKey("changed"));
const cyclic = {};
cyclic.self = cyclic;
assert.throws(() => native.key(cyclic), TypeError);
// Callback-free metadata must hold in Bun/JSC too, not only Node/Vitest.
for (const prototype of [Array.prototype, Object.prototype]) {
  for (const index of ["0", "1"]) {
    const memo = new CanonicalFingerprints();
    const raw = { x: 1, y: { z: true } };
    const expected = canonicalContentKey(raw);
    let getters = 0;
    let setters = 0;
    let observed;
    Object.defineProperty(prototype, index, {
      configurable: true,
      get() {
        getters++;
        return undefined;
      },
      set(value) {
        setters++;
        Object.defineProperty(this, index, { configurable: true, enumerable: true, writable: true, value });
        if (value === true) raw.x = 2;
      },
    });
    try {
      observed = memo.key(raw);
    } finally {
      Reflect.deleteProperty(prototype, index);
    }
    raw.x = 1;
    assert.equal(observed, expected);
    assert.equal(memo.key(raw), canonicalContentKey(raw));
    assert.equal(getters, 0);
    assert.equal(setters, 0);
  }
}
const outcome = (read) => {
  try {
    return { hash: read() };
  } catch (error) {
    return { error: { constructor: error.constructor, message: error.message } };
  }
};
for (const factory of [
  () => new Boolean(true),
  () => new Number(2),
  () => new String("text"),
  () => Object(1n),
  () => Object(Symbol("value")),
]) {
  for (const prototype of [Object.prototype, null]) {
    let calls = 0;
    const memo = new CanonicalFingerprints({}, (value) => {
      calls++;
      return canonicalContentKey(value);
    });
    const boxed = Object.setPrototypeOf(factory(), prototype);
    const raw = { data: Object.create(prototype, Object.getOwnPropertyDescriptors(boxed)) };
    memo.key(raw);
    memo.key(raw);
    assert.equal(calls, 1);
    raw.data = boxed;
    const expected = outcome(() => canonicalContentKey(raw));
    for (let index = 0; index < 2; index++)
      assert.deepEqual(
        outcome(() => memo.key(raw)),
        expected,
      );
    assert.equal(calls, 3);
    assert.equal(memo.retention.nodes, 0);
    memo.clear();
    for (let index = 0; index < 2; index++)
      assert.deepEqual(
        outcome(() => memo.key(raw)),
        expected,
      );
    assert.equal(calls, 5);
    assert.equal(memo.retention.nodes, 0);
  }
}
const arrayKind = { data: [] };
const arrayMemo = new CanonicalFingerprints();
const arrayHash = arrayMemo.key(arrayKind);
arrayKind.data = Object.create(Array.prototype);
assert.equal(arrayMemo.key(arrayKind), canonicalContentKey(arrayKind));
assert.notEqual(arrayMemo.key(arrayKind), arrayHash);
// RawJSON's native slot is not represented by its prototype/descriptors.
// Exercise actual Bun support (not an emulation) on cold and warm reads.
assert.equal(typeof JSON.rawJSON, "function");
assert.equal(typeof JSON.isRawJSON, "function");
for (const payload of ['"text"', "1", "null"]) {
  const raw = JSON.rawJSON(payload);
  assert.equal(JSON.isRawJSON(raw), true);
  const plain = () => Object.create(Object.getPrototypeOf(raw), Object.getOwnPropertyDescriptors(raw));
  assert.equal(JSON.isRawJSON(plain()), false);
  for (const value of [raw, { data: raw }]) {
    let calls = 0;
    const memo = new CanonicalFingerprints({}, (input) => {
      calls++;
      return canonicalContentKey(input);
    });
    for (let index = 0; index < 3; index++) assert.equal(memo.key(value), canonicalContentKey(value));
    assert.equal(calls, 3);
    assert.equal(memo.fallbacks, 3);
    assert.equal(memo.retention.nodes, 0);
  }
  for (const reverse of [false, true]) {
    let calls = 0;
    const memo = new CanonicalFingerprints({}, (input) => {
      calls++;
      return canonicalContentKey(input);
    });
    const value = { data: reverse ? raw : plain() };
    const first = memo.key(value);
    assert.equal(memo.key(value), first);
    if (!reverse) {
      value.data = plain();
      assert.equal(memo.key(value), first);
      assert.equal(calls, 1);
    }
    value.data = reverse ? plain() : raw;
    assert.notEqual(canonicalContentKey(value), first);
    for (let index = 0; index < 2; index++) assert.equal(memo.key(value), canonicalContentKey(value));
    assert.equal(calls, reverse ? 4 : 3);
    assert.equal(memo.retention.nodes, 0);
  }
  // Original stringify still owns raw callbacks and failures on fallback.
  const memo = new CanonicalFingerprints();
  const value = { data: plain() };
  memo.key(value);
  value.data = raw;
  const failure = new Error("original RawJSON sibling getter failure");
  let calls = 0;
  Object.defineProperty(value, "callback", {
    enumerable: true,
    get() {
      calls++;
      throw failure;
    },
  });
  for (let index = 0; index < 2; index++)
    assert.throws(
      () => memo.key(value),
      (error) => error === failure,
    );
  assert.equal(calls, 2);
}
console.log("weak roots collected; bounded snapshots cleared");

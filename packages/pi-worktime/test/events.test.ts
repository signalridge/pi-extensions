import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isWorktimeUpdatePayload,
  parseWorktimeUpdatePayload,
  validateWorktimeUpdatePayload,
  WORKTIME_UPDATE_EVENT,
} from "../src/events.js";

test("exports a namespaced update event", () => {
  assert.equal(WORKTIME_UPDATE_EVENT, "worktime:update");
});

test("accepts only exact plain-object payloads and parses immutable snapshots", () => {
  assert.equal(isWorktimeUpdatePayload({ ms: 0, running: false }), true);
  assert.equal(isWorktimeUpdatePayload(Object.freeze({ ms: 1_000, running: true })), true);

  const parsed = parseWorktimeUpdatePayload({ ms: 2_000, running: true });
  assert.deepEqual(parsed, { ms: 2_000, running: true });
  assert.notEqual(parsed, { ms: 2_000, running: true });
  assert.equal(Object.isFrozen(parsed), true);
  assert.notEqual(parseWorktimeUpdatePayload(parsed), parsed);

  const nullPrototype = Object.create(null) as { ms: number; running: boolean };
  nullPrototype.ms = 1;
  nullPrototype.running = false;
  assert.equal(isWorktimeUpdatePayload(nullPrototype), true);
  assert.equal(validateWorktimeUpdatePayload(nullPrototype), true);
});

test("rejects malformed numeric and boolean fields", () => {
  const malformed: unknown[] = [
    null,
    undefined,
    1,
    "payload",
    [],
    { ms: -1, running: false },
    { ms: Number.NaN, running: false },
    { ms: Number.POSITIVE_INFINITY, running: true },
    { ms: 0, running: 0 },
    { ms: "1", running: true },
    { ms: 0, running: undefined },
  ];

  for (const value of malformed) assert.equal(isWorktimeUpdatePayload(value), false, String(value));
});

test("rejects extra keys, symbol keys, and non-plain prototypes", () => {
  assert.equal(isWorktimeUpdatePayload({ ms: 0, running: false, extra: true }), false);

  const symbol = Symbol("extra");
  const withSymbol = { ms: 0, running: false, [symbol]: true };
  assert.equal(isWorktimeUpdatePayload(withSymbol), false);

  class PayloadClass {
    ms = 0;
    running = false;
  }
  assert.equal(isWorktimeUpdatePayload(new PayloadClass()), false);
  assert.equal(isWorktimeUpdatePayload(Object.create({ ms: 0, running: false })), false);
  assert.equal(isWorktimeUpdatePayload(new Date()), false);
});

test("rejects proxies even when descriptors claim a valid payload", () => {
  const proxy = new Proxy(
    { ms: 1, running: true },
    {
      get(target, property, receiver) {
        if (property === "ms") return 99;
        return Reflect.get(target, property, receiver);
      },
    },
  );

  assert.equal(isWorktimeUpdatePayload(proxy), false);
  assert.equal(validateWorktimeUpdatePayload(proxy), false);
  assert.equal(parseWorktimeUpdatePayload(proxy), undefined);

  const revoked = Proxy.revocable({ ms: 1, running: false }, {});
  revoked.revoke();
  assert.equal(isWorktimeUpdatePayload(revoked.proxy), false);
});

test("rejects accessor fields rather than executing untrusted getters", () => {
  let getterCalled = false;
  const payload = {
    running: false,
    get ms(): number {
      getterCalled = true;
      return 1;
    },
  };

  assert.equal(isWorktimeUpdatePayload(payload), false);
  assert.equal(getterCalled, false);
});

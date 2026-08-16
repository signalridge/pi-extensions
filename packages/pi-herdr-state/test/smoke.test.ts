import { test } from "bun:test";
import assert from "node:assert/strict";
import herdrState from "../src/index.js";

test("is safe to initialize when the herdr bridge is disabled", () => {
  const previous = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  assert.doesNotThrow(() => herdrState({ on: () => {} } as never));
  if (previous === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = previous;
});

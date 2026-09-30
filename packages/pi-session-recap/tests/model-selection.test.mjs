import assert from "node:assert/strict";
import test from "node:test";
import { selectRecapModel } from "../index.ts";

const model = (provider, id) => ({ provider, id, api: "faux-api" });
const select = (available, target) =>
  selectRecapModel(target, {
    find: (provider, id) => available.find((candidate) => candidate.provider === provider && candidate.id === id),
  });

test("only a named, available physical destination is selected", () => {
  const active = model("anthropic", "claude-opus-4-6");
  const target = model("openrouter", "google/gemini-3-flash");
  assert.equal(select([active, target], "openrouter/google/gemini-3-flash"), target);
  assert.equal(select([active, target], "anthropic/claude-opus-4-6"), active);
  assert.equal(select([active], "openrouter/missing-model"), undefined);
  assert.equal(select([active]), undefined);
  assert.equal(select([active], "anthropic"), undefined);
  assert.equal(select([active], "/claude-opus-4-6"), undefined);
  assert.equal(select([active], "anthropic/"), undefined);
});

test("virtual destinations are never dispatched even when explicitly named", () => {
  const virtual = { ...model("router", "auto"), api: "pi-virtual" };
  assert.equal(select([virtual], "router/auto"), undefined);
});

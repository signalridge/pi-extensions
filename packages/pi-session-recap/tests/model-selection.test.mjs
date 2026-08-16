import assert from "node:assert/strict";
import test from "node:test";
import { selectRecapModel } from "../index.ts";

const model = (provider, id) => ({ provider, id });
const select = (active, available, override) =>
  selectRecapModel(active, override, {
    find: (provider, id) => available.find((candidate) => candidate.provider === provider && candidate.id === id),
    getAvailable: () => available,
  });

test("an explicit recap model wins", () => {
  const active = model("anthropic", "claude-opus-4-6");
  const override = model("openrouter", "google/gemini-3-flash");
  assert.equal(select(active, [override], "openrouter/google/gemini-3-flash"), override);
  assert.equal(select(active, [], "openrouter/missing-model"), active);
});

test("Anthropic sessions use Claude Haiku 4.5", () => {
  const active = model("anthropic", "claude-opus-4-6");
  const haiku = model("anthropic", "claude-haiku-4-5");
  assert.equal(select(active, [haiku]), haiku);
});

for (const [provider, activeId, lunaId] of [
  ["openai-codex", "gpt-5.6-sol", "gpt-5.6-luna"],
  ["openrouter", "openai/gpt-5.6-sol", "openai/gpt-5.6-luna"],
  ["cursor", "gpt-5-6-sol@1m", "gpt-5-6-luna@1m"],
]) {
  test(`${provider} GPT sessions use GPT-5.6 Luna`, () => {
    const active = model(provider, activeId);
    const luna = model(provider, lunaId);
    assert.equal(select(active, [luna]), luna);
  });
}

test("non-GPT sessions keep the active model outside Anthropic", () => {
  const active = model("openrouter", "anthropic/claude-opus-4.6");
  const haiku = model("openrouter", "anthropic/claude-haiku-4.5");
  const luna = model("openrouter", "openai/gpt-5.6-luna");
  assert.equal(select(active, [haiku, luna]), active);
});

test("an unavailable cheaper model falls back to the active model", () => {
  const active = model("openai-codex", "gpt-5.6-sol");
  assert.equal(select(active, []), active);
});

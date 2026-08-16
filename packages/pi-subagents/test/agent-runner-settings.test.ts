import type { Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getDefaultMaxTurns,
  getDefaultModel,
  getGraceTurns,
  normalizeMaxTurns,
  resolveConfiguredDefaultModel,
  setDefaultMaxTurns,
  setDefaultModel,
  setGraceTurns,
} from "../src/agent-runner.js";
import type { ModelRegistry } from "../src/model-resolver.js";

describe("setDefaultMaxTurns / getDefaultMaxTurns", () => {
  beforeEach(() => {
    setDefaultMaxTurns(undefined);
  });

  it("defaults to undefined (unlimited)", () => {
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("stores a positive integer", () => {
    setDefaultMaxTurns(30);
    expect(getDefaultMaxTurns()).toBe(30);
  });

  it("accepts boundary value 1", () => {
    setDefaultMaxTurns(1);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("treats 0 as unlimited", () => {
    setDefaultMaxTurns(0);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("clamps negative values to 1", () => {
    setDefaultMaxTurns(-10);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("undefined resets to unlimited after being set", () => {
    setDefaultMaxTurns(50);
    expect(getDefaultMaxTurns()).toBe(50);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });
});

describe("normalizeMaxTurns", () => {
  it("treats undefined as unlimited", () => {
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
  });

  it("treats 0 as unlimited", () => {
    expect(normalizeMaxTurns(0)).toBeUndefined();
  });

  it("keeps positive values", () => {
    expect(normalizeMaxTurns(7)).toBe(7);
  });

  it("clamps negative values to 1", () => {
    expect(normalizeMaxTurns(-3)).toBe(1);
  });
});

describe("setGraceTurns / getGraceTurns", () => {
  beforeEach(() => {
    setGraceTurns(5);
  });

  it("defaults to 5", () => {
    expect(getGraceTurns()).toBe(5);
  });

  it("stores a positive integer", () => {
    setGraceTurns(10);
    expect(getGraceTurns()).toBe(10);
  });

  it("accepts boundary value 1", () => {
    setGraceTurns(1);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps 0 to 1", () => {
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps negative values to 1", () => {
    setGraceTurns(-5);
    expect(getGraceTurns()).toBe(1);
  });
});

describe("setDefaultModel / getDefaultModel", () => {
  beforeEach(() => {
    setDefaultModel(undefined);
  });

  it("defaults to undefined (follow the parent session)", () => {
    expect(getDefaultModel()).toBeUndefined();
  });

  it("stores a provider/model reference, trimmed", () => {
    setDefaultModel("  anthropic/claude-haiku-4-5 ");
    expect(getDefaultModel()).toBe("anthropic/claude-haiku-4-5");
  });

  it("keeps \"inherit\" verbatim rather than collapsing it to undefined", () => {
    // The two behave alike at spawn time but not on disk: the snapshot writes
    // this value out, and only an explicit "inherit" overrides a global default.
    setDefaultModel("inherit");
    expect(getDefaultModel()).toBe("inherit");
  });

  it("treats blank as unset", () => {
    setDefaultModel("anthropic/claude-haiku-4-5");
    setDefaultModel("   ");
    expect(getDefaultModel()).toBeUndefined();
  });
});

describe("resolveConfiguredDefaultModel", () => {
  const haiku = { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic" };
  const models = [haiku];
  const registry = {
    find: (provider: string, id: string) =>
      models.find(m => m.provider === provider && m.id === id),
    getAll: () => models,
    getAvailable: () => models,
  } as unknown as ModelRegistry<Model<any>>;

  beforeEach(() => {
    setDefaultModel(undefined);
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveConfiguredDefaultModel(registry)).toBeUndefined();
  });

  it("resolves a configured reference against the registry", () => {
    setDefaultModel("anthropic/claude-haiku-4-5");
    expect(resolveConfiguredDefaultModel(registry)).toBe(haiku);
  });

  it("resolves a reference the fuzzy way, as a hand-written config would spell it", () => {
    setDefaultModel("claude-haiku-4.5");
    expect(resolveConfiguredDefaultModel(registry)).toBe(haiku);
  });

  it("treats \"inherit\" as no default, leaving the parent model in force", () => {
    setDefaultModel("inherit");
    expect(resolveConfiguredDefaultModel(registry)).toBeUndefined();
  });

  it("yields to the parent when the machine cannot resolve the reference", () => {
    // Unlike a tier, this value was never named at a call site, so an
    // unavailable provider must not take every spawn on this machine down.
    setDefaultModel("elsewhere/unknown-model");
    expect(resolveConfiguredDefaultModel(registry)).toBeUndefined();
  });
});

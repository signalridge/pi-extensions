/**
 * agent-tiers.test.ts — user-named model tiers for ordinary subagent spawns.
 *
 * The resolver is the whole feature: every spawn path (top-level Agent tool,
 * nested delegation, the scheduler, cross-extension RPC) reaches it through the
 * one call in `agent-runner.ts`, so precedence and the fail-closed refusals are
 * exercised here rather than four times over.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentTierError,
  agentTierApplies,
  buildAgentTierListText,
  buildAgentTierParameterDescription,
  buildCompactAgentTierListText,
  getAgentTiersConfiguredSettings,
  getAgentTiersSettings,
  getRoutingPolicySnapshot,
  isValidAgentTierKey,
  MAX_AGENT_TIER_KEY_LENGTH,
  offerableTierThinking,
  removeAgentTierProfile,
  resolveAgentTier,
  selectAgentTier,
  setAgentTiersSettings,
  setDefaultAgentTier,
  shippedFallbackAgentTier,
  upsertAgentTierProfile,
} from "../src/agent-tiers.js";
import type { ModelRegistry } from "../src/model-resolver.js";
import type { AgentTiersSettings } from "../src/settings.js";
import { loadSettings, saveSettings, TIER_THINKING_LEVELS } from "../src/settings.js";
import type { AgentConfig } from "../src/types.js";

const parent = {
  id: "parent",
  name: "Parent",
  provider: "test",
  reasoning: true,
} as unknown as Model<any>;
/** `null` marks an unsupported level, so this model tops out below `high`. */
const fast = {
  id: "fast",
  name: "Fast",
  provider: "test",
  reasoning: true,
  thinkingLevelMap: { high: null, xhigh: null, max: null },
} as unknown as Model<any>;
const registryModels = [parent, fast];
const registry: ModelRegistry<Model<any>> = {
  find: (provider, id) =>
    registryModels.find(
      (model) => model.provider === provider && model.id === id,
    ),
  getAll: () => registryModels,
  getAvailable: () => registryModels,
};

function config(fields: Partial<AgentConfig>): AgentConfig {
  return {
    name: "worker",
    description: "worker",
    extensions: true,
    skills: true,
    systemPrompt: "",
    promptMode: "replace",
    ...fields,
  };
}

/** Two arbitrary names, to prove nothing is hardcoded to small/medium/large. */
const settings: AgentTiersSettings = {
  defaultTier: "everyday",
  profiles: {
    everyday: {
      model: "test/parent",
      thinking: "medium",
      description: "Ordinary implementation work",
    },
    deep: {
      model: "test/fast",
      thinking: "max",
      description: "Architecture and risky review",
    },
    passthrough: { model: "inherit", thinking: "inherit" },
  },
};

describe("agent tier resolution", () => {
  it("accepts arbitrary tier names, not a fixed small/medium/large vocabulary", () => {
    const result = resolveAgentTier({
      requestedTier: "deep",
      settings,
      parentModel: parent,
      modelRegistry: registry,
    });

    expect(result.model).toBe(fast);
    expect(result.snapshot?.tier).toBe("deep");
    expect(result.snapshot?.source).toBe("call");
    expect(result.snapshot?.configuredModel).toBe("test/fast");
  });

  it("falls back to the tier key when a profile carries no description", () => {
    expect(buildAgentTierListText(settings)).toContain(
      "- deep: Architecture and risky review",
    );
    // `passthrough` has no description, so the key stands in for one.
    expect(buildAgentTierListText(settings)).toContain(
      "- passthrough: passthrough",
    );
  });

  it("applies the configured default when neither the caller nor the agent names a tier", () => {
    const result = resolveAgentTier({
      settings,
      parentModel: fast,
      modelRegistry: registry,
    });

    expect(result.snapshot?.tier).toBe("everyday");
    expect(result.snapshot?.source).toBe("default");
    expect(result.model).toBe(parent);
  });

  it("takes the tier from agent frontmatter over the configured default", () => {
    const result = resolveAgentTier({
      agentConfig: config({ agentTier: "deep" }),
      settings,
      parentModel: parent,
      modelRegistry: registry,
    });

    expect(result.snapshot?.tier).toBe("deep");
    expect(result.snapshot?.source).toBe("frontmatter");
  });

  it("takes the caller's tier over the agent's own default tier", () => {
    const result = resolveAgentTier({
      requestedTier: "everyday",
      agentConfig: config({ agentTier: "deep" }),
      settings,
      parentModel: parent,
      modelRegistry: registry,
    });

    expect(result.snapshot?.tier).toBe("everyday");
    expect(result.snapshot?.source).toBe("call");
  });

  it("inherits the parent model and thinking when the profile says so", () => {
    const result = resolveAgentTier({
      requestedTier: "passthrough",
      settings,
      parentModel: parent,
      parentThinking: "high",
      modelRegistry: registry,
    });

    expect(result.model).toBe(parent);
    expect(result.thinkingLevel).toBe("high");
    expect(result.snapshot?.configuredThinking).toBe("inherit");
  });

  it("clamps a thinking level the selected model does not support", () => {
    const clampSettings: AgentTiersSettings = {
      profiles: { demanding: { model: "test/fast", thinking: "max" } },
    };
    const result = resolveAgentTier({
      requestedTier: "demanding",
      settings: clampSettings,
      parentModel: parent,
      modelRegistry: registry,
    });

    expect(result.snapshot?.requestedThinking).toBe("max");
    expect(result.snapshot?.clamped).toBe(true);
    expect(result.snapshot?.diagnostic).toMatch(/not supported by test\/fast/);
  });

  it("returns nothing at all when no tier applies, leaving legacy behavior intact", () => {
    const result = resolveAgentTier({
      agentConfig: config({ model: "test/fast", thinking: "max" }),
      settings: {},
      parentModel: parent,
      modelRegistry: registry,
    });

    expect(result.snapshot).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.thinkingLevel).toBeUndefined();
  });
});

describe("shipped fallback tier for managed calls", () => {
  beforeEach(() => {
    setAgentTiersSettings({});
  });

  const resolveWithNoTier = (settings = getAgentTiersSettings()) =>
    resolveAgentTier({ settings, parentModel: parent, parentThinking: "high", modelRegistry: registry });

  const resolveRequiringTier = (settings = getAgentTiersSettings()) =>
    resolveAgentTier({
      settings,
      requireTier: true,
      parentModel: parent,
      parentThinking: "high",
      modelRegistry: registry,
    });

  it("applies `medium` to a managed call on a fresh install", () => {
    const resolved = resolveRequiringTier();
    expect(resolved.snapshot).toMatchObject({ tier: "medium", source: "default", configuredModel: "inherit" });
    // Provider-neutral: the profile inherits, so this commits to an effort
    // level and the parent model is what actually runs.
    expect(resolved.model).toBe(parent);
  });

  it("leaves an ordinary spawn untiered so defaultModel and the parent still apply", () => {
    // The reason the fallback is scoped rather than a catalogue default: an
    // ordinary spawn that reaches it would silence `defaultModel` and pin a
    // thinking level on a machine that configured neither.
    expect(getAgentTiersSettings().defaultTier).toBeUndefined();
    expect(resolveWithNoTier().snapshot).toBeUndefined();
    expect(agentTierApplies({})).toBe(false);
    expect(agentTierApplies({ requireTier: true })).toBe(true);
  });

  it("is not written back into the settings file", () => {
    expect(getAgentTiersConfiguredSettings().defaultTier).toBeUndefined();
    // The UI edits the effective view and hands it back; that round trip must
    // not pin a default the user never chose.
    setAgentTiersSettings(upsertAgentTierProfile(getAgentTiersSettings(), "mine", { model: "test/fast", thinking: "low" }));
    expect(getAgentTiersConfiguredSettings().defaultTier).toBeUndefined();
  });

  it("yields to a configured default, which also applies to ordinary spawns", () => {
    setAgentTiersSettings({ defaultTier: "low" });
    expect(resolveRequiringTier().snapshot?.tier).toBe("low");
    expect(resolveWithNoTier().snapshot?.tier).toBe("low");
  });

  it("stays cleared when the user explicitly chose no default", () => {
    setAgentTiersSettings(setDefaultAgentTier(getAgentTiersSettings(), { kind: "none" }));
    expect(getAgentTiersSettings().defaultTier).toBeUndefined();
    expect(getAgentTiersConfiguredSettings().noDefaultTier).toBe(true);
    // `noDefaultTier` is the one way to make a managed call fail closed too.
    expect(resolveWithNoTier().snapshot).toBeUndefined();
    expect(resolveRequiringTier().snapshot).toBeUndefined();
  });

  it("disappears with the profile it names", () => {
    setAgentTiersSettings(removeAgentTierProfile(getAgentTiersSettings(), "medium"));
    expect(resolveRequiringTier().snapshot).toBeUndefined();
  });

  it("does not apply when the configured default is a tombstone", () => {
    setAgentTiersSettings({ blockedDefaultTier: true });
    expect(getAgentTiersSettings().defaultTier).toBeUndefined();
    expect(() => resolveRequiringTier()).toThrow(/blocked by malformed configuration/);
    // The refusal belongs to the tier path, so the legacy path must not answer
    // in its place.
    expect(agentTierApplies({ requireTier: true })).toBe(true);
  });

  it("reports what `unset` would reach, so the Settings menu cannot promise a tier that is gone", () => {
    // The menu offers `unset` and `none` as different choices, and the only
    // difference between them is this value. On a catalogue that removed the
    // shipped profile they behave identically, and the row has to say so
    // instead of naming a fallback that no longer resolves.
    expect(shippedFallbackAgentTier()).toBe("medium");
    // A current choice is not the question: `unset` means "if I cleared this".
    setAgentTiersSettings(setDefaultAgentTier(getAgentTiersSettings(), { kind: "none" }));
    expect(shippedFallbackAgentTier()).toBe("medium");
    setAgentTiersSettings(removeAgentTierProfile(getAgentTiersSettings(), "medium"));
    expect(shippedFallbackAgentTier()).toBeUndefined();
  });

  it("selects the same tier for a managed label as the runner will resolve", () => {
    // The managed-spawn path needs the tier KEY before the runner resolves, to
    // label a tombstone and the lifecycle events. It asks this function rather
    // than rebuilding the fallback beside it, so the label can never name a
    // tier other than the one that runs.
    const explore = { name: "Explore", agentTier: "low" } as AgentConfig;
    expect(selectAgentTier({ requireTier: true })).toEqual({ tier: "medium", source: "default" });
    expect(selectAgentTier({ requireTier: true, agentConfig: explore })).toEqual({
      tier: "low",
      source: "frontmatter",
    });
    expect(selectAgentTier({ requireTier: true, requestedTier: "high", agentConfig: explore })).toEqual({
      tier: "high",
      source: "call",
    });
    // A fail-closed catalogue produces no label; the runner owns the refusal.
    setAgentTiersSettings(setDefaultAgentTier(getAgentTiersSettings(), { kind: "none" }));
    expect(selectAgentTier({ requireTier: true })).toBeUndefined();
  });

  it("is what the managed routing policy publishes, so a peer cannot disagree", () => {
    expect(getRoutingPolicySnapshot().policy.defaultTier).toBe("medium");
    setAgentTiersSettings(setDefaultAgentTier(getAgentTiersSettings(), { kind: "none" }));
    expect(getRoutingPolicySnapshot().policy.defaultTier).toBeNull();
  });
});

describe("routing policy snapshot", () => {
  beforeEach(() => {
    setAgentTiersSettings({});
  });

  it("publishes only what decides how a tier resolves", () => {
    setAgentTiersSettings({
      profiles: { mine: { model: "test/fast", thinking: "medium", description: "prose for the host model" } },
      blockedProfiles: ["broken"],
    });
    const { policy, fingerprint } = getRoutingPolicySnapshot();
    expect(policy.profiles.mine).toEqual({ model: "test/fast", thinking: "medium" });
    expect(policy.blockedProfiles).toEqual(["broken"]);
    expect(policy.defaultTier).toBe("medium");
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Descriptions are host-side UI prose; a peer keying a replay cache on this
    // must not re-run work because someone reworded one.
    expect(JSON.stringify(policy)).not.toContain("prose for the host model");
  });

  it("is stable across key order and changes with policy", () => {
    const before = getRoutingPolicySnapshot().fingerprint;
    setAgentTiersSettings({ profiles: { b: { model: "test/fast", thinking: "low" }, a: { model: "test/fast", thinking: "low" } } });
    const reordered = getRoutingPolicySnapshot().fingerprint;
    setAgentTiersSettings({ profiles: { a: { model: "test/fast", thinking: "low" }, b: { model: "test/fast", thinking: "low" } } });
    expect(getRoutingPolicySnapshot().fingerprint).toBe(reordered);
    expect(reordered).not.toBe(before);
  });
});

describe("setAgentTiersSettings shipped profiles", () => {
  beforeEach(() => {
    setAgentTiersSettings({});
  });

  it("ships exactly the low/medium/high ladder on a fresh install", () => {
    setAgentTiersSettings({});
    // One name per effort level. A second shipped name for an effort level
    // already covered would be a synonym the user has to learn and maintain.
    expect(Object.keys(getAgentTiersSettings().profiles ?? {}).sort()).toEqual(["high", "low", "medium"]);
  });

  it("ships the `low` tier Explore names in its frontmatter", () => {
    setAgentTiersSettings({});
    const result = resolveAgentTier({
      requestedTier: "low",
      settings: getAgentTiersSettings(),
      parentModel: parent,
      parentThinking: "high",
      modelRegistry: registry,
    });
    expect(result.snapshot?.tier).toBe("low");
    expect(result.snapshot?.source).toBe("call");
  });

  it("a user-defined `low` profile wins over the shipped one", () => {
    setAgentTiersSettings({
      profiles: { low: { model: "test/parent", thinking: "high", description: "mine" } },
    });
    const resolved = resolveAgentTier({
      requestedTier: "low",
      settings: getAgentTiersSettings(),
      parentModel: parent,
      parentThinking: "high",
      modelRegistry: registry,
    });
    expect(resolved.model?.id).toBe("parent");
  });

  it("a blocked `low` is not resurrected by the shipped merge", () => {
    setAgentTiersSettings({ blockedProfiles: ["low"] });
    expect(getAgentTiersSettings().profiles?.low).toBeUndefined();
  });

  it("deleting the shipped `low` tombstones it so it does not come back", () => {
    setAgentTiersSettings({});
    const afterDelete = removeAgentTierProfile(getAgentTiersSettings(), "low");
    setAgentTiersSettings(afterDelete);
    expect(getAgentTiersSettings().profiles?.low).toBeUndefined();
    expect(getAgentTiersSettings().blockedProfiles).toContain("low");
  });

  it("redefining a deleted shipped tier retires the tombstone", () => {
    setAgentTiersSettings({});
    setAgentTiersSettings(removeAgentTierProfile(getAgentTiersSettings(), "low"));
    setAgentTiersSettings(upsertAgentTierProfile(getAgentTiersSettings(), "low", { model: "test/parent", thinking: "medium" }));
    setAgentTiersSettings(getAgentTiersSettings());
    expect(getAgentTiersSettings().profiles?.low).toBeDefined();
    expect(getAgentTiersSettings().blockedProfiles ?? []).not.toContain("low");
  });

  it("shows the shipped tier in the rendered catalogue when nothing else is configured", () => {
    setAgentTiersSettings({});
    expect(buildAgentTierListText(getAgentTiersSettings())).toContain("low");
    // "(shipped)", not "(shipped default)": none of these is the catalogue default.
    expect(buildAgentTierListText(getAgentTiersSettings())).toContain("(shipped)");
  });

  it("the configured view stays empty so persistence never writes shipped tiers", () => {
    setAgentTiersSettings({});
    expect(getAgentTiersSettings().profiles?.low).toBeDefined();
    expect(getAgentTiersConfiguredSettings().profiles).toBeUndefined();
    expect(getAgentTiersConfiguredSettings().defaultTier).toBeUndefined();
  });

  it("user-configured tiers are reflected in the configured view", () => {
    setAgentTiersSettings({
      profiles: { custom: { model: "test/fast", thinking: "medium" } },
      defaultTier: "custom",
    });
    expect(getAgentTiersConfiguredSettings().defaultTier).toBe("custom");
    expect(getAgentTiersConfiguredSettings().profiles?.custom).toBeDefined();
  });
});

describe("agent tier refusals", () => {
  const attempt = (input: Parameters<typeof resolveAgentTier>[0]) => () =>
    resolveAgentTier(input);

  it("refuses a tier the caller named that does not exist, naming what does", () => {
    expect(
      attempt({
        requestedTier: "nope",
        settings,
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/Unknown agent tier "nope".*deep, everyday, passthrough/s);
  });

  it("refuses a tier whose profile was dropped as malformed rather than substituting one", () => {
    const blocked: AgentTiersSettings = {
      ...settings,
      blockedProfiles: ["deep"],
    };

    expect(
      attempt({
        requestedTier: "deep",
        settings: blocked,
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(AgentTierError);
    expect(
      attempt({
        requestedTier: "deep",
        settings: blocked,
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/blocked by a malformed profile/);
  });

  it("refuses a tier whose model is unavailable instead of falling back to the parent", () => {
    const missing: AgentTiersSettings = {
      profiles: { gone: { model: "test/absent", thinking: "max" } },
    };

    expect(
      attempt({
        requestedTier: "gone",
        settings: missing,
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/has an unavailable model/);
  });

  it("refuses a malformed defaultTier rather than picking one", () => {
    expect(
      attempt({
        settings: { blockedDefaultTier: true },
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/defaultTier is blocked/);
  });

  it("refuses a syntactically invalid key", () => {
    expect(
      attempt({
        requestedTier: "two words",
        settings,
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/Invalid agent tier key/);
    expect(isValidAgentTierKey("")).toBe(false);
    expect(isValidAgentTierKey("x".repeat(MAX_AGENT_TIER_KEY_LENGTH + 1))).toBe(
      false,
    );
    expect(isValidAgentTierKey("research")).toBe(true);
  });

  it("names the origin so the error says which of the three sources chose the tier", () => {
    expect(
      attempt({
        requestedTier: "nope",
        settings,
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/requested by the caller/);
    expect(
      attempt({
        agentConfig: config({ agentTier: "nope" }),
        settings,
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/set by agent "worker"/);
    expect(
      attempt({
        settings: { defaultTier: "nope" },
        parentModel: parent,
        modelRegistry: registry,
      }),
    ).toThrow(/the configured agentTiers.defaultTier/);
  });
});

describe("agent tier catalogue rendered for the host", () => {
  it("lists every key with its description, model, thinking and the default", () => {
    const text = buildAgentTierListText(settings);

    expect(text).toContain("Available agent tiers:");
    expect(text).toContain("- everyday: Ordinary implementation work");
    expect(text).toContain("model: test/parent");
    expect(text).toContain("thinking: medium");
    expect(text).toContain("Default tier: everyday");
    expect(text).toContain(
      "The caller may pass only a tier key. Do not pass model or thinking directly.",
    );
  });

  it("renders one line per tier in compact mode", () => {
    const text = buildCompactAgentTierListText(settings);

    expect(text).toContain(
      "- deep: Architecture and risky review (test/fast, thinking max)",
    );
    expect(text).toContain("Default: everyday.");
  });

  it("names the available keys in the tier parameter's own description", () => {
    expect(buildAgentTierParameterDescription(settings)).toContain(
      "Available: deep, everyday, passthrough",
    );
    expect(buildAgentTierParameterDescription(settings)).toContain(
      '"everyday"',
    );
  });

  it("renders nothing when no tier is configured, so the description stays as it was", () => {
    expect(buildAgentTierListText({})).toBe("");
    expect(buildCompactAgentTierListText({})).toBe("");
  });
});

describe("agentTiers settings merge", () => {
  let root: string;
  let projectDir: string;
  let previousAgentDir: string | undefined;

  const writeGlobal = (value: unknown) =>
    writeFileSync(join(root, "agent", "subagents.json"), JSON.stringify(value));
  const writeProject = (value: unknown) =>
    writeFileSync(
      join(projectDir, ".pi", "subagents.json"),
      JSON.stringify(value),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-subagents-tiers-"));
    projectDir = join(root, "project");
    mkdirSync(join(root, "agent"), { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("inherits global profiles the project does not mention", () => {
    writeGlobal({
      agentTiers: { defaultTier: "everyday", profiles: settings.profiles },
    });
    writeProject({
      agentTiers: {
        profiles: { deep: { model: "test/parent", thinking: "high" } },
      },
    });

    const loaded = loadSettings(projectDir).agentTiers;
    expect(loaded?.profiles?.everyday).toEqual(settings.profiles?.everyday);
    // Replaced whole, not merged field by field: the description is gone with it.
    expect(loaded?.profiles?.deep).toEqual({
      model: "test/parent",
      thinking: "high",
    });
    expect(loaded?.defaultTier).toBe("everyday");
  });

  it("lets the project override the global defaultTier", () => {
    writeGlobal({
      agentTiers: { defaultTier: "everyday", profiles: settings.profiles },
    });
    writeProject({ agentTiers: { defaultTier: "deep" } });

    expect(loadSettings(projectDir).agentTiers?.defaultTier).toBe("deep");
  });

  it("blocks a global profile the project redefined badly instead of reviving it", () => {
    writeGlobal({
      agentTiers: {
        profiles: { deep: { model: "test/fast", thinking: "max" } },
      },
    });
    writeProject({
      agentTiers: { profiles: { deep: { model: "test/parent" } } },
    });

    const loaded = loadSettings(projectDir).agentTiers;
    expect(loaded?.profiles?.deep).toBeUndefined();
    expect(loaded?.blockedProfiles).toContain("deep");
  });

  it("drops a profile missing either half rather than implying inherit", () => {
    writeGlobal({
      agentTiers: {
        profiles: {
          ok: { model: "test/fast", thinking: "max" },
          noThinking: { model: "test/fast" },
          noModel: { thinking: "max" },
          extraKey: { model: "test/fast", thinking: "max", secret: "x" },
        },
      },
    });

    const loaded = loadSettings(projectDir).agentTiers;
    expect(Object.keys(loaded?.profiles ?? {})).toEqual(["ok"]);
    expect(loaded?.blockedProfiles).toEqual([
      "extraKey",
      "noModel",
      "noThinking",
    ]);
  });

  it("keeps the catalogue when a retired workflow key is present alongside it", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeGlobal({
        workflow: { defaultTier: "small", tiers: { small: { agentTier: "low" } } },
        agentTiers: { defaultTier: "everyday", profiles: settings.profiles },
      });

      const loaded = loadSettings(projectDir);
      expect(loaded).not.toHaveProperty("workflow");
      expect(loaded.agentTiers?.defaultTier).toBe("everyday");
    } finally {
      warning.mockRestore();
    }
  });

  it("round-trips a catalogue built by the tier editor", () => {
    // The editor's output has to survive `sanitize`; a shape it rejects would
    // vanish on save behind a success toast.
    const edited = setDefaultAgentTier(
      upsertAgentTierProfile({}, "everyday", {
        model: "test/parent",
        thinking: "medium",
        description: "ordinary work",
      }),
      { kind: "tier", tier: "everyday" },
    );
    saveSettings({ agentTiers: edited }, projectDir);
    expect(loadSettings(projectDir).agentTiers).toEqual(edited);
  });
});

/**
 * Catalogue edits, as made by `/agents → Model tiers`.
 *
 * The menu is a thin caller: these functions carry the rules that outlive it,
 * so they are exercised here rather than through a terminal.
 */
describe("tier catalogue edits", () => {
  const everyday = { model: "test/parent", thinking: "medium" } as const;
  const deep = { model: "test/fast", thinking: "low" } as const;

  it("defines a new tier alongside the existing ones", () => {
    expect(upsertAgentTierProfile({ profiles: { everyday } }, "deep", deep)).toEqual({
      profiles: { everyday, deep },
    });
  });

  it("replaces an existing profile whole", () => {
    // Whole-profile replacement matches how project settings override global:
    // never field by field, which would pair a model with a thinking level
    // nobody chose for it.
    expect(
      upsertAgentTierProfile({ profiles: { everyday } }, "everyday", {
        model: "test/fast",
        thinking: "max",
        description: "now the fast one",
      }),
    ).toEqual({
      profiles: { everyday: { model: "test/fast", thinking: "max", description: "now the fast one" } },
    });
  });

  it("retires a key's tombstone when that key is defined again", () => {
    expect(
      upsertAgentTierProfile({ profiles: { everyday }, blockedProfiles: ["deep", "other"] }, "deep", deep),
    ).toEqual({ profiles: { everyday, deep }, blockedProfiles: ["other"] });
  });

  it("deletes a profile and its tombstone", () => {
    expect(
      removeAgentTierProfile({ profiles: { everyday, deep }, blockedProfiles: ["deep"] }, "deep"),
    ).toEqual({ profiles: { everyday } });
  });

  it("clears defaultTier when the tier it named is deleted", () => {
    // Leaving it would turn every later spawn that names no tier into a hard
    // refusal — a strange thing to get from deleting a tier you stopped using.
    expect(removeAgentTierProfile({ defaultTier: "deep", profiles: { everyday, deep } }, "deep")).toEqual({
      profiles: { everyday },
    });
  });

  it("leaves a defaultTier pointing at a surviving tier alone", () => {
    expect(removeAgentTierProfile({ defaultTier: "everyday", profiles: { everyday, deep } }, "deep")).toEqual({
      defaultTier: "everyday",
      profiles: { everyday },
    });
  });

  it("serializes an emptied catalogue as nothing, not as empty containers", () => {
    expect(removeAgentTierProfile({ profiles: { everyday } }, "everyday")).toEqual({});
  });

  it("sets the default tier and clears the malformed-default tombstone", () => {
    // The tombstone describes the value this call replaces; keeping it would
    // make the resolver refuse the choice the user just made explicitly.
    expect(
      setDefaultAgentTier({ profiles: { everyday }, blockedDefaultTier: true }, { kind: "tier", tier: "everyday" }),
    ).toEqual({ defaultTier: "everyday", profiles: { everyday } });
  });

  it("clears the default tier as an explicit choice, not an absent field", () => {
    // A shipped default exists, so an absent `defaultTier` means "no opinion"
    // and would be filled back in. Clearing has to say "none" out loud.
    expect(
      setDefaultAgentTier({ defaultTier: "everyday", profiles: { everyday } }, { kind: "none" }),
    ).toEqual({
      noDefaultTier: true,
      profiles: { everyday },
    });
    expect(setDefaultAgentTier({ noDefaultTier: true, profiles: { everyday } }, { kind: "tier", tier: "everyday" })).toEqual({
      defaultTier: "everyday",
      profiles: { everyday },
    });
    // "unset" is the third state: no default, and the shipped managed fallback
    // is reachable again. A single `undefined` could not say which of the two
    // the user meant.
    expect(setDefaultAgentTier({ noDefaultTier: true, profiles: { everyday } }, { kind: "unset" })).toEqual({
      profiles: { everyday },
    });
  });

});

describe("offerableTierThinking", () => {
  it("offers every level for inherit, where the model is not knowable yet", () => {
    expect(offerableTierThinking("inherit", registry)).toEqual([...TIER_THINKING_LEVELS]);
  });

  it("offers every level for a model this machine cannot resolve", () => {
    // Refusing here would make the menu weaker than hand-editing the file: a
    // shared config may name a provider only some teammates have authed.
    expect(offerableTierThinking("elsewhere/unknown-model", registry)).toEqual([...TIER_THINKING_LEVELS]);
  });

  it("offers only the levels the named model supports, plus inherit", () => {
    // `fast` maps high/xhigh/max to null. Offering them would promise a level
    // that resolveAgentTier silently clamps down at spawn time.
    expect(offerableTierThinking("test/fast", registry)).toEqual(["inherit", "minimal", "low", "medium"]);
  });
});

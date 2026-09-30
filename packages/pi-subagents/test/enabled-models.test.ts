import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ModelRegistryRef, readEnabledModels, resolveEnabledModels } from "../src/enabled-models.js";
import { checkModelScope, setScopeModelsEnabled } from "../src/model-scope.js";

/** Mock models matching typical registry shape. */
const MODELS = [
  { id: "gemma-4-31b-it", name: "Gemma 4 31B", provider: "google" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

function makeRegistry(models = MODELS, available?: typeof MODELS): ModelRegistryRef {
  return {
    getAll() { return models; },
    getAvailable: available ? () => available : undefined,
  };
}

describe("readEnabledModels", () => {
  let agentDir: string;
  let projectDir: string;
  let originalEnv: string | undefined;

  const projectFile = () => join(projectDir, ".pi", "settings.json");
  const globalFile = () => join(agentDir, "settings.json");

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-em-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-em-project-"));
    originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalEnv;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify(obj));
  }

  it("returns undefined when both settings files are missing", () => {
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("returns undefined when field absent from both files", () => {
    writeFileSync(globalFile(), JSON.stringify({ defaultProvider: "openai" }));
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("returns enabledModels from global when project file absent", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6", "google/gemma-4-31b-it"],
    }));
    expect(readEnabledModels(projectDir)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "google/gemma-4-31b-it",
    ]);
  });

  it("returns enabledModels from project when global file absent", () => {
    writeProject({ enabledModels: ["anthropic/claude-haiku-4-5"] });
    expect(readEnabledModels(projectDir)).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("project overrides global (array replaces wholly, mirrors pi's deep-merge)", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
    }));
    writeProject({ enabledModels: ["anthropic/claude-haiku-4-5"] });
    // Project replaces wholly — globals NOT merged in
    expect(readEnabledModels(projectDir)).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("falls back to global when project file has no enabledModels field", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6"],
    }));
    writeProject({ defaultProvider: "anthropic" }); // project exists but no enabledModels
    expect(readEnabledModels(projectDir)).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("returns undefined when global JSON is corrupt (try/catch swallow)", () => {
    writeFileSync(globalFile(), "not json {{{");
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("returns undefined when enabledModels is not an array (global)", () => {
    writeFileSync(globalFile(), JSON.stringify({ enabledModels: "anthropic/claude-sonnet-4-6" }));
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("returns undefined when enabledModels is not an array (project)", () => {
    writeProject({ enabledModels: "anthropic/claude-haiku-4-5" });
    // Project's non-array enabledModels is invalid → falls back to global; global empty → undefined
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("keeps a partly malformed project scope rather than falling back to global", () => {
    writeFileSync(globalFile(), JSON.stringify({ enabledModels: ["google/gemma-4-31b-it"] }));
    writeProject({ enabledModels: ["anthropic/claude-sonnet-4-6", 123] });
    expect(readEnabledModels(projectDir)).toEqual(["anthropic/claude-sonnet-4-6", ""]);
    expect(resolveEnabledModels(readEnabledModels(projectDir), makeRegistry())).toEqual(
      new Set(["anthropic/claude-sonnet-4-6"]),
    );
  });

  it("does not disable scope when every configured item is malformed", () => {
    writeProject({ enabledModels: [123] });
    setScopeModelsEnabled(true);
    try {
      expect(checkModelScope({
        model: MODELS[0],
        cwd: projectDir,
        modelRegistry: makeRegistry(),
        callerSupplied: true,
        agentLabel: "worker",
      }).kind).toBe("error");
    } finally {
      setScopeModelsEnabled(false);
    }
  });

  it("does not disable model scope when the configured model becomes unavailable", () => {
    writeProject({ enabledModels: ["anthropic/claude-sonnet-4-6"] });
    let available = [MODELS[4], MODELS[3]];
    const registry = { getAll: () => MODELS, getAvailable: () => available };
    const args = {
      model: MODELS[3],
      cwd: projectDir,
      modelRegistry: registry,
      callerSupplied: true,
      agentLabel: "worker",
    };
    setScopeModelsEnabled(true);
    try {
      expect(checkModelScope(args).kind).toBe("error");
      available = [MODELS[3]];
      expect(checkModelScope(args)).toMatchObject({
        kind: "error",
        message: expect.stringContaining("no configured models are currently available"),
      });
      expect(checkModelScope({ ...args, callerSupplied: false }).kind).toBe("warn");
    } finally {
      setScopeModelsEnabled(false);
    }
  });

  it("honors Pi glob patterns without turning a valid scope into deny-all", () => {
    writeProject({ enabledModels: ["anthropic/*"] });
    setScopeModelsEnabled(true);
    try {
      const args = {
        cwd: projectDir,
        modelRegistry: makeRegistry(),
        callerSupplied: true,
        agentLabel: "worker",
      };
      expect(checkModelScope({ ...args, model: MODELS[3] }).kind).toBe("ok");
      expect(checkModelScope({ ...args, model: MODELS[0] }).kind).toBe("error");
    } finally {
      setScopeModelsEnabled(false);
    }
  });
});

describe("resolveEnabledModels", () => {
  it("returns undefined for empty patterns", () => {
    expect(resolveEnabledModels([], makeRegistry())).toBeUndefined();
    expect(resolveEnabledModels(undefined, makeRegistry())).toBeUndefined();
  });

  it("returns an empty allowlist when configured models do not match", () => {
    expect(resolveEnabledModels(["nonexistent/foo"], makeRegistry())).toEqual(new Set());
  });

  it("skips empty string patterns", () => {
    const result = resolveEnabledModels(["", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"], makeRegistry());
    // Empty string should not match — only exact patterns should match
    expect(result!.size).toBe(2);
  });

  it("skips whitespace-only patterns", () => {
    const result = resolveEnabledModels(["  ", "google/gemma-4-31b-it"], makeRegistry());
    expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
  });

  it("returns an empty allowlist when no configured models are available", () => {
    const result = resolveEnabledModels(
      ["anthropic/claude-haiku-4-5"],
      makeRegistry(MODELS, []),
    );
    expect(result).toEqual(new Set());
  });

  it("deduplicates duplicate patterns", () => {
    const result = resolveEnabledModels(
      ["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5"],
      makeRegistry(),
    );
    expect(result!.size).toBe(1); // duplicate resolves to one entry
  });

  describe("exact provider/modelId", () => {
    it("resolves exact match (key stored lowercase)", () => {
      const result = resolveEnabledModels(["google/gemma-4-31b-it"], makeRegistry());
      expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
    });

    it("resolves model id with colon (part of id, not split)", () => {
      const result = resolveEnabledModels(
        ["anthropic/claude-opus-4-6"],
        makeRegistry(),
      );
      expect(result).toEqual(new Set(["anthropic/claude-opus-4-6"]));
    });

    it("is case-insensitive", () => {
      const result = resolveEnabledModels(["GOOGLE/GEMMA-4-31B-IT"], makeRegistry());
      expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
    });
  });

  describe("Pi model-scope patterns", () => {
    it("resolves an unambiguous bare model id", () => {
      expect(resolveEnabledModels(["gemma-4-31b-it"], makeRegistry()))
        .toEqual(new Set(["google/gemma-4-31b-it"]));
    });

    it("resolves a partial model name to the newest alias", () => {
      expect(resolveEnabledModels(["Opus"], makeRegistry()))
        .toEqual(new Set(["anthropic/claude-opus-4-6"]));
    });

    it("matches glob patterns against full references and bare ids", () => {
      expect(resolveEnabledModels(["anthropic/*:high", "*gemma*"], makeRegistry()))
        .toEqual(new Set([
          "anthropic/claude-opus-4-6",
          "anthropic/claude-opus-4-5",
          "anthropic/claude-haiku-4-5",
          "anthropic/claude-sonnet-4-6",
          "google/gemma-4-31b-it",
        ]));
    });

    it("follows Pi's bare-ID glob matching across providers", async () => {
      const models = [
        { id: "claude-sonnet", name: "Sonnet", provider: "anthropic" },
        { id: "anthropic/claude-sonnet", name: "Routed Sonnet", provider: "openrouter" },
      ];
      const patterns = ["anthropic/*"];
      const pi = await resolveModelScopeWithDiagnostics(patterns, {
        getAvailable: async () => models,
      } as unknown as ModelRuntime);
      const piKeys = new Set(pi.scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
      expect(piKeys).toEqual(new Set(["anthropic/claude-sonnet", "openrouter/anthropic/claude-sonnet"]));
      expect(resolveEnabledModels(patterns, makeRegistry(models))).toEqual(piKeys);
    });

    it("prefers an exact model id containing a thinking-level suffix", () => {
      const exact = { id: "example:high", name: "Example", provider: "custom" };
      const base = { id: "example", name: "Example", provider: "custom" };
      expect(resolveEnabledModels(["custom/example:high"], makeRegistry([base, exact])))
        .toEqual(new Set(["custom/example:high"]));
    });

    it("prefers an exact bare ID containing a thinking-level word", () => {
      const base = { id: "example", name: "Example", provider: "custom" };
      const suffixed = { id: "example:high", name: "Example High", provider: "custom" };
      expect(resolveEnabledModels(["example:high"], makeRegistry([base, suffixed])))
        .toEqual(new Set(["custom/example:high"]));
    });

    it("agrees with Pi on provider-qualified partial references", async () => {
      const models = [
        { id: "model-a", name: "Model A", provider: "p" },
        { id: "model:high-speed-v2", name: "Fast Model", provider: "p" },
        { id: "model-a", name: "Model A", provider: "other" },
      ];
      const patterns = ["p/model", "p/model:high-speed"];
      const pi = await resolveModelScopeWithDiagnostics(patterns, {
        getAvailable: async () => models,
      } as unknown as ModelRuntime);
      const piKeys = new Set(pi.scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
      expect(piKeys).toEqual(new Set());
      expect(resolveEnabledModels(patterns, makeRegistry(models))).toEqual(piKeys);
    });

    it("agrees with Pi when a thinking-suffixed glob matches base and colon IDs", async () => {
      const models = [
        { id: "example", name: "Example", provider: "custom" },
        { id: "example:high", name: "Example High", provider: "custom" },
      ];
      const patterns = ["custom/*:high"];
      const pi = await resolveModelScopeWithDiagnostics(patterns, {
        getAvailable: async () => models,
      } as unknown as ModelRuntime);
      const piKeys = new Set(pi.scopedModels.map(({ model }) => `${model.provider}/${model.id}`));
      expect(piKeys).toEqual(new Set(["custom/example", "custom/example:high"]));
      expect(resolveEnabledModels(patterns, makeRegistry(models))).toEqual(piKeys);
    });

    it("accepts Pi's invalid thinking suffix fallback for a non-glob reference", () => {
      const base = { id: "example", name: "Example", provider: "custom" };
      expect(resolveEnabledModels(["custom/example:ultra"], makeRegistry([base])))
        .toEqual(new Set(["custom/example"]));
    });

    it("keeps a configured unmatched pattern as an empty allowlist", () => {
      expect(resolveEnabledModels(["anthropic/retired-*"], makeRegistry())).toEqual(new Set());
    });
  });



  describe("mixed patterns", () => {
    it("combines multiple exact provider/modelId in one call", () => {
      const result = resolveEnabledModels(
        ["google/gemma-4-31b-it", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"],
        makeRegistry(),
      );
      expect(result!.has("google/gemma-4-31b-it".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-haiku-4-5".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-sonnet-4-6".toLowerCase())).toBe(true);
      expect(result!.has("google/gemini-2.5-pro".toLowerCase())).toBe(false);
      expect(result!.has("anthropic/claude-opus-4-6".toLowerCase())).toBe(false);
    });
  });

  describe("getAvailable filtering", () => {
    it("resolves only against available models when getAvailable present", () => {
      const available = [MODELS[0], MODELS[3]]; // google + haiku only
      const result = resolveEnabledModels(
        ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6", "google/gemma-4-31b-it"],
        makeRegistry(MODELS, available),
      );
      // haiku and google are available; sonnet is not
      expect(result!.has("anthropic/claude-haiku-4-5".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-sonnet-4-6".toLowerCase())).toBe(false); // not available
      expect(result!.has("google/gemma-4-31b-it".toLowerCase())).toBe(true);
    });

    it("does not reuse a project's allowed models for another project with matching file metadata", () => {
      const firstCwd = mkdtempSync(join(tmpdir(), "pi-em-first-"));
      const secondCwd = mkdtempSync(join(tmpdir(), "pi-em-second-"));
      try {
        const settings = JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"] });
        const timestamp = new Date("2025-01-01T00:00:00Z");
        for (const cwd of [firstCwd, secondCwd]) {
          mkdirSync(join(cwd, ".pi"));
          const path = join(cwd, ".pi", "settings.json");
          writeFileSync(path, settings);
          utimesSync(path, timestamp, timestamp);
        }
        const firstStat = statSync(join(firstCwd, ".pi", "settings.json"));
        const secondStat = statSync(join(secondCwd, ".pi", "settings.json"));
        expect([firstStat.mtimeMs, firstStat.size]).toEqual([secondStat.mtimeMs, secondStat.size]);

        const patterns = ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"];
        expect(resolveEnabledModels(patterns, makeRegistry(MODELS, [MODELS[4]]), firstCwd))
          .toEqual(new Set(["anthropic/claude-sonnet-4-6"]));
        expect(resolveEnabledModels(patterns, makeRegistry(MODELS, [MODELS[3]]), secondCwd))
          .toEqual(new Set(["anthropic/claude-haiku-4-5"]));
      } finally {
        rmSync(firstCwd, { recursive: true, force: true });
        rmSync(secondCwd, { recursive: true, force: true });
      }
    });

    it("re-resolves when availability changes within one registry", () => {
      const patterns = ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"];
      let available = [MODELS[4]];
      const registry: ModelRegistryRef = {
        getAll: () => MODELS,
        getAvailable: () => available,
      };

      expect(resolveEnabledModels(patterns, registry)).toEqual(new Set(["anthropic/claude-sonnet-4-6"]));
      available = [MODELS[3]];
      expect(resolveEnabledModels(patterns, registry)).toEqual(new Set(["anthropic/claude-haiku-4-5"]));
    });
  });
});

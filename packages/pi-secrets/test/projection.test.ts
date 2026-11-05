import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { compilePattern } from "../src/patterns.js";
import { PROJECTION_EVENT, registerProjection } from "../src/projection.js";
import { SecretRegistry } from "../src/registry.js";
import type { SecretsSession } from "../src/session.js";

describe("synchronous projection provider", () => {
  function fixture() {
    const events = createEventBus();
    const registry = new SecretRegistry({
      key: "test",
      literals: [],
      patterns: [
        { label: "VALUE", source: "configPattern", regex: compilePattern("value=([A-Za-z0-9]{12})"), group: 1 },
      ],
    });
    const stats = { requests: 0, lastRequestReplacements: 0, restoredCalls: 0, restoredPlaceholders: 0, failures: 0 };
    let leaf: string | null = "leaf";
    const ctx = { sessionManager: { getSessionId: () => "session", getLeafId: () => leaf } } as ExtensionContext;
    const owner = { session: { registry, stats } as SecretsSession, ctx };
    let current: typeof owner | undefined = owner;
    registerProjection({ events } as ExtensionAPI, () => current);
    let project!: (request: unknown) => { version: number; ok: boolean; texts?: string[] };
    events.emit(PROJECTION_EVENT, {
      version: 1,
      accept: (service: { project: typeof project }) => {
        project = service.project;
      },
    });
    const request = (texts: unknown) => ({ version: 1, sessionId: "session", leafId: leaf, texts });
    return {
      events,
      owner,
      stats,
      project,
      request,
      setLeaf: (value: string | null) => {
        leaf = value;
      },
      replace: () => {
        current = { ...owner };
      },
      shutdown: () => {
        current = undefined;
      },
    };
  }

  it("discovers the full batch before rewriting and preserves original strings and old restoration", () => {
    const f = fixture();
    const input = Object.freeze(["bare Abc123456789", "value=Abc123456789"]);
    const result = f.project(f.request(input));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.texts)).not.toContain("Abc123456789");
    expect(input).toEqual(["bare Abc123456789", "value=Abc123456789"]);
    expect(f.owner.session.registry.restore(result.texts?.[0] ?? "").text).toBe(input[0]);
  });

  it("refuses sparse, inherited, accessor and non-string batches without invoking getters", () => {
    const f = fixture();
    let accessed = false;
    const accessor = ["a"];
    Object.defineProperty(accessor, "0", {
      get() {
        accessed = true;
        return "value=Abc123456789";
      },
    });
    const overridden = Object.defineProperty(["value=Abc123456789"], "map", {
      value: () => {
        accessed = true;
        return ["private-value"];
      },
    });
    for (const texts of [
      overridden,
      new Array(1),
      accessor,
      [1],
      Object.create(["value=Abc123456789"]),
      ["x".repeat(8 * 1024 * 1024 + 1)],
    ]) {
      expect(f.project(f.request(texts))).toEqual({ version: 1, ok: false });
    }
    expect(accessed).toBe(false);
    expect(f.owner.session.registry.counts().configPattern).toBe(0);
  });

  it("retired owners and wrong sessions/leaves refuse even with a previously admitted capability", () => {
    const f = fixture();
    expect(f.project({ ...f.request([]), sessionId: "other" }).ok).toBe(false);
    expect(f.project({ ...f.request([]), leafId: "other" }).ok).toBe(false);
    f.setLeaf(null);
    expect(f.project(f.request([])).ok).toBe(true);
    f.replace();
    expect(f.project(f.request([])).ok).toBe(false);
    f.shutdown();
    let service: unknown;
    f.events.emit(PROJECTION_EVENT, {
      version: 1,
      accept: (claim: unknown) => {
        service = claim;
      },
    });
    expect(service).toMatchObject({ version: 1, project: expect.any(Function) });
    expect((service as { project: typeof f.project }).project(f.request([])).ok).toBe(false);
  });

  it("contains provider exceptions and returns only a value-free refusal", () => {
    const f = fixture();
    f.owner.session.registry.discover = () => {
      throw new Error("private-value");
    };
    expect(f.project(f.request(["value=Abc123456789"]))).toEqual({ version: 1, ok: false });
    expect(f.stats.failures).toBe(1);
  });
});

/**
 * strengths.test.ts — the workflow strength vocabulary.
 *
 * A workflow speaks one word about cost. A script names a strength —
 * `low`/`medium`/`high` — and a `strengths` table is the only thing that binds
 * one to an Agent tier: an unmapped strength dispatches with no tier and takes
 * the agent's own default. A host that has configured nothing gets the shipped
 * default table, identity wherever it defines a tier of the same name, so the
 * built-ins' effort distinctions survive an unconfigured machine. Because that
 * is a table and not a rule, the user replaces it — which is how workflow `low`
 * is re-priced without dragging the Explore agent's `low` along. A call that
 * names no strength stays out of it entirely and sends no tier, so an unlabelled
 * dispatch never outranks the agent type's own. pi-subagents still owns every
 * model, thinking level, and the only resolver; this table only decides which
 * key a workflow asks for.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type ManagedRoutingPolicy,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  routingPolicyFingerprint,
} from "@signalridge/pi-subagents-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOWS } from "../src/builtins.js";
import { WORKFLOW_CAPABILITIES } from "../src/capabilities.js";
import piWorkflows, { buildAdHocWorkflowScript } from "../src/index.js";
import { runWorkflow } from "../src/runtime.js";
import { WORKFLOW_STRENGTHS } from "../src/strengths.js";
import { loadProjectWorkflowSettings, loadWorkflowSettings, saveWorkflowSettings } from "../src/workflow-settings.js";

const POLICY = {
  defaultTier: "medium",
  profiles: {
    low: { model: "inherit", thinking: "low" },
    medium: { model: "inherit", thinking: "medium" },
    high: { model: "inherit", thinking: "high" },
  },
  blockedProfiles: [],
  blockedDefaultTier: false,
};

/** Collect the tier each dispatch actually requested; undefined means none was sent. */
function tierRecorder(): {
  seen: Array<string | undefined>;
  agent: { run: (p: string, o?: { tier?: string }) => Promise<unknown> };
} {
  const seen: Array<string | undefined> = [];
  return {
    seen,
    agent: {
      run: async (_prompt: string, options?: { tier?: string }) => {
        seen.push(options?.tier);
        // Satisfies every schema the quality helpers impose, so one recorder
        // serves the plain-agent cases and the helper cases alike.
        return { real: true, complete: true, score: 1 };
      },
    },
  };
}

const TIERED_SCRIPT = `export const meta = { name: "tiered", description: "t" };
const a = await agent("fanout", { strength: "low" });
const b = await agent("ordinary", { strength: "medium" });
return "done";`;

describe("workflow strengths", () => {
  it("runs a script's strength on the tier the table names", async () => {
    const { seen, agent } = tierRecorder();
    const logs: string[] = [];
    await runWorkflow(TIERED_SCRIPT, {
      routingPolicy: POLICY as never,
      strengths: { low: "high", medium: "low" },
      onLog: (message: string) => logs.push(message),
      agent,
    });
    expect(seen).toEqual(["high", "low"]);
    expect(logs.join("\n")).toContain('workflow strength "low" runs on agent tier "high"');
  });

  it("dispatches an unmapped strength with no tier at all", async () => {
    // The heart of it. A strength the table does not define must not find the
    // catalogue tier that happens to share its spelling — otherwise re-pricing
    // workflow `low` would re-price every ordinary `low` spawn with it.
    const { seen, agent } = tierRecorder();
    const logs: string[] = [];
    await runWorkflow(TIERED_SCRIPT, {
      routingPolicy: POLICY as never,
      strengths: { medium: "high" },
      onLog: (message: string) => logs.push(message),
      agent,
    });
    expect(seen).toEqual([undefined, "high"]);
    expect(logs.join("\n")).toContain(`workflow strength "low" is unmapped; using the agent's own default`);
  });

  it("starts each strength on the same-named tier when nothing is configured", async () => {
    // The unconfigured stock machine. Without this the shipped scripts' whole
    // low/medium vocabulary would collapse onto pi-subagents' managed default,
    // which is the more expensive rung — a fan-out would get dearer, not
    // cheaper, on exactly the machine that never opted into anything.
    const { seen, agent } = tierRecorder();
    const logs: string[] = [];
    await runWorkflow(TIERED_SCRIPT, {
      routingPolicy: POLICY as never,
      onLog: (message: string) => logs.push(message),
      agent,
    });
    expect(seen).toEqual(["low", "medium"]);
    // The default is drawn from this host's own catalogue, so it can never be
    // stale, and a run must never complain about configuration nobody wrote.
    expect(logs.join("\n")).not.toContain("ignored");
  });

  it("maps nothing, silently, when the host names its tiers differently", async () => {
    // The same default on a host whose tiers are cheap/deep yields no entries
    // at all: computed against the live catalogue rather than hardcoded, so it
    // is never an assertion about someone else's tier names.
    const { seen, agent } = tierRecorder();
    const logs: string[] = [];
    await runWorkflow(TIERED_SCRIPT, {
      routingPolicy: {
        defaultTier: "deep",
        profiles: {
          cheap: { model: "inherit", thinking: "low" },
          deep: { model: "inherit", thinking: "high" },
        },
        blockedProfiles: [],
        blockedDefaultTier: false,
      } as never,
      onLog: (message: string) => logs.push(message),
      agent,
    });
    expect(seen).toEqual([undefined, undefined]);
    expect(logs.join("\n")).not.toContain("ignored");
  });

  it("treats an explicit empty table as no mappings, unlike an absent one", async () => {
    // The two are different statements now that absent means the shipped
    // default: `{}` is how a user says "map nothing, every strength takes the
    // agent's own default" on a host that does define low/medium/high.
    const { seen, agent } = tierRecorder();
    await runWorkflow(TIERED_SCRIPT, {
      routingPolicy: POLICY as never,
      strengths: {},
      agent,
    });
    expect(seen).toEqual([undefined, undefined]);
  });

  it("complains about a stale entry once per run, not once per nested frame", async () => {
    // The table is resolved once at the top frame and shared, so a child cannot
    // re-derive it and re-report the same complaint at its own boundary.
    const logs: string[] = [];
    const parent = `export const meta = { name: "p", description: "p" };
await agent("outer", { strength: "low" });
return await workflow("child");`;
    const child = `export const meta = { name: "c", description: "c" };
return await agent("inner", { strength: "low" });`;
    await runWorkflow(parent, {
      routingPolicy: POLICY as never,
      strengths: { low: "gone" },
      loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
      onLog: (message: string) => logs.push(message),
      agent: { run: async () => ({ real: true }) },
    });
    expect(logs.filter((line) => line.includes('workflow strength "low" → tier "gone" ignored'))).toHaveLength(1);
  });

  it("sends no tier for a call that names no strength, whatever the table says", async () => {
    // There is deliberately no default strength. A default would have pinned
    // every unlabelled call to whatever it mapped to, and a tier a call requests
    // outranks the agent type's own — so `agent("x", { agentType: "Explore" })`
    // would have overruled Explore's shipped `tier: low` and re-priced the one
    // agent this whole indirection exists to leave alone.
    const { seen, agent } = tierRecorder();
    const logs: string[] = [];
    await runWorkflow(
      `export const meta = { name: "bare", description: "b" };
await agent("unlabelled");
return await agent("also unlabelled", { agentType: "Explore" });`,
      {
        routingPolicy: POLICY as never,
        // Every strength mapped, so nothing here is unmapped-by-omission: the
        // calls stay untiered because they named no strength at all.
        strengths: { low: "high", medium: "high", high: "high" },
        onLog: (message: string) => logs.push(message),
        agent,
      },
    );
    expect(seen).toEqual([undefined, undefined]);
    // Nor is it reported as a routed strength; there was no strength to route.
    expect(logs.filter((line) => line.includes("workflow strength"))).toEqual([]);
  });

  it("rejects a word outside the vocabulary before any dispatch", async () => {
    // The vocabulary is closed, so an unknown word is a typo rather than a
    // strength nobody configured — and a typo that dispatched in silence would
    // be indistinguishable from one that was deliberately left unmapped.
    const { seen, agent } = tierRecorder();
    await expect(
      runWorkflow(
        `export const meta = { name: "typo", description: "t" };
return await agent("x", { strength: "lowe" });`,
        { routingPolicy: POLICY as never, agent },
      ),
    ).rejects.toThrow(/agent strength must be one of low, medium, high \(received "lowe"\)/);
    expect(seen).toEqual([]);
  });

  it("takes one hop, never a chain", async () => {
    // `low → medium` and `medium → high` must not compose into `low → high`;
    // a chain would make the table order-dependent and able to cycle.
    const { seen, agent } = tierRecorder();
    await runWorkflow(TIERED_SCRIPT, {
      routingPolicy: POLICY as never,
      strengths: { low: "medium", medium: "high" },
      agent,
    });
    expect(seen).toEqual(["medium", "high"]);
  });

  it("honors a strength mapped to its own spelling", async () => {
    // Once the passthrough went away this stopped being a no-op: within a
    // written table `low → low` is the only way to say "run this on the
    // catalogue tier of the same name" — the shipped default says it for an
    // absent table, not for a present one that omits the entry — so dropping it
    // as redundant would silently mean the opposite. `medium` proves the other
    // half: writing a table at all replaces the default wholesale.
    const { seen, agent } = tierRecorder();
    await runWorkflow(TIERED_SCRIPT, {
      routingPolicy: POLICY as never,
      strengths: { low: "low" },
      agent,
    });
    expect(seen).toEqual(["low", undefined]);
  });

  it("ignores a table entry whose tier this host does not define, once, at start", async () => {
    // A stale entry costs the redirect, not every workflow on the machine: the
    // strength is simply left unmapped, which is the unconfigured behavior.
    const { seen, agent } = tierRecorder();
    const logs: string[] = [];
    await runWorkflow(TIERED_SCRIPT, {
      routingPolicy: POLICY as never,
      strengths: { low: "gone", medium: "high" },
      onLog: (message: string) => logs.push(message),
      agent,
    });
    expect(seen).toEqual([undefined, "high"]);
    const ignored = logs.filter((line) => line.includes('workflow strength "low" → tier "gone" ignored'));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain("high, low, medium");
  });

  it("reports each strength once per run, not once per dispatch or per frame", async () => {
    // A fan-out asks for the same strength dozens of times and the answer never
    // changes; the nested frame shares the set so "once per run" stays true
    // across a workflow() boundary too.
    const logs: string[] = [];
    const parent = `export const meta = { name: "p", description: "p" };
await parallel([1, 2, 3].map(() => () => agent("wide", { strength: "low" })));
return await workflow("child");`;
    const child = `export const meta = { name: "c", description: "c" };
return await agent("inner", { strength: "low" });`;
    await runWorkflow(parent, {
      routingPolicy: POLICY as never,
      strengths: { low: "high" },
      loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
      onLog: (message: string) => logs.push(message),
      agent: { run: async () => ({ real: true }) },
    });
    expect(logs.filter((line) => line.includes('workflow strength "low" runs on agent tier "high"'))).toHaveLength(1);
  });

  it("re-runs a call whose routing moved, and replays one whose routing did not", async () => {
    // The strength resolves before the resume hash is taken, so the hash already
    // keys on the tier that will be requested: no separate table field is needed
    // in the agent identity.
    const journal = new Map<string, { index: number; runId: string; hash: string; result: unknown }>();
    const calls: string[] = [];
    const run = (strengths: Record<string, string> | undefined, resumeJournal?: typeof journal): Promise<unknown> =>
      runWorkflow(TIERED_SCRIPT, {
        runId: "strength-resume",
        routingPolicy: POLICY as never,
        strengths,
        resumeJournal,
        agent: {
          run: async (prompt: string) => {
            calls.push(prompt);
            return { real: true };
          },
        },
        onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry as never),
      });

    await run({ low: "medium" });
    expect(calls).toEqual(["fanout", "ordinary"]);

    await run({ low: "medium" }, journal);
    expect(calls).toEqual(["fanout", "ordinary"]);

    // `low` now routes elsewhere. That call's cached answer was produced under a
    // different tier, so it re-runs — and everything after a miss runs with it.
    await run({ low: "high" }, journal);
    expect(calls).toEqual(["fanout", "ordinary", "fanout", "ordinary"]);
  });

  it("invalidates a cached nested workflow when only the table changed", async () => {
    // The parent caches one value for the whole child frame and keys it on the
    // whole-catalogue fingerprint, which does not move when only the table does.
    const journal = new Map<string, { index: number; runId: string; hash: string; result: unknown }>();
    const dispatched: Array<string | undefined> = [];
    const parent = `export const meta = { name: "parent", description: "p" };
return await workflow("child");`;
    const child = `export const meta = { name: "child", description: "c" };
return await agent("inner", { strength: "low" });`;

    const run = (strengths: Record<string, string> | undefined, resumeJournal?: typeof journal) =>
      runWorkflow(parent, {
        runId: "strength-nested",
        routingPolicy: POLICY as never,
        routingPolicyFingerprint: "fixed-fingerprint",
        strengths,
        resumeJournal,
        loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
        agent: {
          run: async (_prompt: string, options?: { tier?: string }) => {
            dispatched.push(options?.tier);
            return { real: true };
          },
        },
        onAgentJournal: () => {},
        onWorkflowJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry as never),
      });

    await run({ low: "medium" });
    expect(dispatched).toEqual(["medium"]);

    await run({ low: "medium" }, journal);
    expect(dispatched).toEqual(["medium"]);

    await run({ low: "high" }, journal);
    expect(dispatched).toEqual(["medium", "high"]);
  });
});

describe("every shipped script stays inside the vocabulary", () => {
  // The invariant behind "give every step a strength": if a shipped script has
  // even one unlabelled dispatch, the table stops being a complete cost dial
  // and the user has no way to reach that call. Asserted against a host whose
  // tiers are named nothing like the strengths — the one place this package
  // invents tier names, because the proof needs dispatches that cannot have
  // been routed by a coincidence of spelling.
  const FOREIGN = {
    defaultTier: "deep",
    profiles: {
      cheap: { model: "inherit", thinking: "low" },
      deep: { model: "inherit", thinking: "high" },
    },
    blockedProfiles: [],
    blockedDefaultTier: false,
  };
  /**
   * The smallest value a schema accepts, derived from the schema itself.
   *
   * One fixed object cannot serve every shipped script: several close their
   * schemas with `additionalProperties: false`, and the ad-hoc planner needs a
   * non-empty `tasks` array to have anything to orchestrate.
   */
  const minimalFor = (schema: unknown): unknown => {
    if (!schema || typeof schema !== "object") return "ok";
    const node = schema as {
      type?: string;
      required?: string[];
      properties?: Record<string, unknown>;
      items?: unknown;
    };
    if (node.type === "object") {
      const out: Record<string, unknown> = {};
      for (const key of node.required ?? []) out[key] = minimalFor(node.properties?.[key]);
      return out;
    }
    if (node.type === "array") return [minimalFor(node.items)];
    if (node.type === "boolean") return true;
    if (node.type === "number") return 1;
    return "ok";
  };
  const shipped = (): Array<[string, string]> => [
    ...Object.entries(BUILTIN_WORKFLOWS).map(([name, d]) => [name, d.script] as [string, string]),
    // The ad-hoc script ships too but lives in index.ts, outside BUILTIN_WORKFLOWS.
    ["ad-hoc", buildAdHocWorkflowScript("a user task")],
  ];

  it("routes every shipped dispatch through the table", async () => {
    for (const [name, script] of shipped()) {
      const tiers: Array<string | undefined> = [];
      await runWorkflow(script, {
        args: { question: "q", task: "t", topic: "p", scope: "s" },
        routingPolicy: FOREIGN as never,
        strengths: { low: "cheap", medium: "deep", high: "deep" },
        agent: {
          run: async (_prompt: string, options?: { tier?: string; schema?: unknown }) => {
            tiers.push(options?.tier);
            return minimalFor(options?.schema);
          },
        },
      });
      expect(tiers.length, `${name} dispatched nothing`).toBeGreaterThan(0);
      expect(
        tiers.filter((tier) => tier !== "cheap" && tier !== "deep"),
        `${name} escaped the table`,
      ).toEqual([]);
    }
  });

  it("dispatches every shipped call with no tier when the host names its tiers differently", async () => {
    // The shipped default is identity *where the host defines the name*, and
    // this host defines cheap/deep — so nothing binds, nothing is sent, and
    // pi-subagents decides exactly as it would for any other spawn. The
    // unconfigured stock machine is the opposite case, covered above.
    for (const [name, script] of shipped()) {
      const tiers: Array<string | undefined> = [];
      await runWorkflow(script, {
        args: { question: "q", task: "t", topic: "p", scope: "s" },
        routingPolicy: FOREIGN as never,
        agent: {
          run: async (_prompt: string, options?: { tier?: string; schema?: unknown }) => {
            tiers.push(options?.tier);
            return minimalFor(options?.schema);
          },
        },
      });
      expect(tiers.length, `${name} dispatched nothing`).toBeGreaterThan(0);
      expect(
        tiers.filter((tier) => tier !== undefined),
        `${name} sent a tier`,
      ).toEqual([]);
    }
  });
});

describe("quality helpers that spawn", () => {
  // verify/judgePanel/completenessCheck dispatch on the script's behalf, so the
  // script never gets to label those calls. They carry a documented default and
  // accept an override, which is what keeps every spawn inside the vocabulary.
  it("defaults verify's reviewers to low and lets the caller override", async () => {
    const first = tierRecorder();
    await runWorkflow(
      `export const meta = { name: "v", description: "v" };
return await verify("claim", { reviewers: 2 });`,
      {
        routingPolicy: POLICY as never,
        strengths: { low: "low", medium: "high" },
        agent: first.agent,
      },
    );
    expect(first.seen).toEqual(["low", "low"]);

    const second = tierRecorder();
    await runWorkflow(
      `export const meta = { name: "v", description: "v" };
return await verify("claim", { reviewers: 1, strength: "medium" });`,
      {
        routingPolicy: POLICY as never,
        strengths: { low: "low", medium: "high" },
        agent: second.agent,
      },
    );
    expect(second.seen).toEqual(["high"]);
  });

  it("defaults judgePanel's judges to low", async () => {
    // Same shape as verify: many narrow scores, averaged, so no single judge's
    // depth carries the choice. No shipped script calls it, so this is the only
    // thing keeping its dispatches inside the vocabulary.
    const { seen, agent } = tierRecorder();
    await runWorkflow(
      `export const meta = { name: "j", description: "j" };
return await judgePanel(["a", "b"], { judges: 1 });`,
      {
        routingPolicy: POLICY as never,
        strengths: { low: "low", high: "high" },
        agent,
      },
    );
    expect(seen).toEqual(["low", "low"]);

    const override = tierRecorder();
    await runWorkflow(
      `export const meta = { name: "j", description: "j" };
return await judgePanel(["a"], { judges: 1, strength: "high" });`,
      {
        routingPolicy: POLICY as never,
        strengths: { low: "low", high: "high" },
        agent: override.agent,
      },
    );
    expect(override.seen).toEqual(["high"]);
  });

  it("defaults completenessCheck to medium, which has no vote to carry a shallow verdict", async () => {
    const { seen, agent } = tierRecorder();
    await runWorkflow(
      `export const meta = { name: "c", description: "c" };
return await completenessCheck({ task: "t" }, ["r"]);`,
      {
        routingPolicy: POLICY as never,
        strengths: { low: "low", medium: "high" },
        agent,
      },
    );
    expect(seen).toEqual(["high"]);
  });
});

describe("workflow strength settings", () => {
  let agentDir: string;
  let projectDir: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-workflows-strengths-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-workflows-project-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** Write the global settings file the project file layers over. */
  function writeGlobal(settings: unknown): void {
    const dir = join(agentDir, "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  }

  it("keeps entries a run could honor and drops the rest", () => {
    saveWorkflowSettings(
      {
        strengths: {
          low: "medium",
          // A self-named entry is real configuration now, not a no-op: it is the
          // only way to ask for the catalogue tier of the same name.
          high: "high",
          // Outside the closed vocabulary, so it can never match what a script
          // asks for — storing it would be a line that can never fire.
          large: "medium",
          // The value side is only a shape test, but a whitespace key could not
          // be rendered as a bare token in an error message.
          medium: "wf medium",
        } as Record<string, string>,
      },
      projectDir,
    );
    expect(loadWorkflowSettings(projectDir).strengths).toEqual({
      low: "medium",
      high: "high",
    });
  });

  it("omits the key entirely when nothing survives", () => {
    saveWorkflowSettings({ strengths: { nonsense: "medium" } as Record<string, string> }, projectDir);
    expect(loadWorkflowSettings(projectDir).strengths).toBeUndefined();
  });

  it("keeps an explicit empty table, which a dropped one is not", () => {
    // Absent means the shipped default, so "map nothing" needs a way to be
    // said. A table whose every entry was dropped is a broken file rather than
    // that statement, and storing it as one would promote a typo to a policy —
    // the case above.
    writeGlobal({ strengths: { low: "medium" } });
    saveWorkflowSettings({ strengths: {} }, projectDir);
    expect(loadWorkflowSettings(projectDir).strengths).toEqual({});
  });

  it("lets a project table replace the global one, and inherits it when absent", () => {
    writeGlobal({ strengths: { low: "medium", medium: "high" } });
    expect(loadWorkflowSettings(projectDir).strengths).toEqual({
      low: "medium",
      medium: "high",
    });

    // A project that defines the table owns it outright, so it can shorten the
    // inherited one and not only extend it.
    saveWorkflowSettings({ strengths: { low: "high" } }, projectDir);
    expect(loadWorkflowSettings(projectDir).strengths).toEqual({ low: "high" });
  });

  it("reads project scope without the global values layered in", () => {
    // What a settings command has to edit. saveWorkflowSettings replaces the
    // project file with whatever it is handed, so an edit built on the merged
    // view would copy every global value into the project and the project would
    // stop tracking the global file from then on.
    writeGlobal({ progressMode: "detailed", strengths: { low: "high" } });
    saveWorkflowSettings({ ...loadProjectWorkflowSettings(projectDir), effort: "ultra" }, projectDir);

    const written: unknown = JSON.parse(readFileSync(loadProjectSettingsPath(agentDir, projectDir), "utf8"));
    expect(written).toEqual({ effort: "ultra" });
    expect(loadWorkflowSettings(projectDir).progressMode).toBe("detailed");
    expect(loadWorkflowSettings(projectDir).strengths).toEqual({ low: "high" });
  });

  it("survives a malformed table without losing the other settings", () => {
    writeGlobal({ progressMode: "detailed", strengths: ["low", "medium"] });
    const settings = loadWorkflowSettings(projectDir);
    expect(settings.strengths).toBeUndefined();
    expect(settings.progressMode).toBe("detailed");
  });

  it("exposes exactly the vocabulary the runtime enforces", () => {
    expect([...WORKFLOW_STRENGTHS]).toEqual(["low", "medium", "high"]);
  });

  it("publishes the same vocabulary in the capability contract", () => {
    // WORKFLOW_CAPABILITIES has to stay a literal-only array — check:capabilities
    // evaluates it in an empty VM realm — so the strength option's type is
    // spelled out on each helper that takes it rather than derived. This is the
    // drift protection the shared constant would otherwise have given: four
    // copies, one vocabulary.
    const rendered = WORKFLOW_STRENGTHS.map((name) => `"${name}"`).join(" | ");
    const strengthOptions = WORKFLOW_CAPABILITIES.flatMap((entry) =>
      (entry.options ?? []).filter((option) => option.name === "strength"),
    );
    expect(strengthOptions.length).toBeGreaterThan(0);
    for (const option of strengthOptions) expect(option.kind).toBe(rendered);
  });
});

/** Mirror of workflow-settings' private project path derivation, for the file assertion. */
function loadProjectSettingsPath(agentDir: string, cwd: string): string {
  const absolute = resolve(cwd);
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  return join(agentDir, "workflows", "projects", `${basename(absolute) || "root"}-${digest}`, "settings.json");
}

describe("/workflows strength", () => {
  // The command is the only place a user meets this table, and the only place
  // that has to reconcile two owners: the strengths are ours, the tiers are
  // pi-subagents'. Its seed is the table a run would actually use rather than
  // this project's file, because every level of the key replaces the one below
  // instead of merging into it.
  let agentDir: string;
  let projectDir: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-workflows-cmd-agent-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-workflows-cmd-project-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** Deliberately not named like the strengths: routing must never be a coincidence of spelling. */
  const HOST_POLICY: ManagedRoutingPolicy = {
    defaultTier: "standard",
    profiles: {
      cheap: { model: "inherit", thinking: "low" },
      standard: { model: "inherit", thinking: "medium" },
    },
    blockedProfiles: [],
    blockedDefaultTier: false,
  };

  /**
   * The smallest host the extension will activate against.
   *
   * Only the pieces `/workflows strength` touches: the ping that carries the
   * tier catalogue, command registration, and a cwd so settings land in the
   * temp project rather than the developer's own.
   */
  function activate(policy: ManagedRoutingPolicy | undefined): {
    run: (args: string) => Promise<string[]>;
    shutdown: () => Promise<void>;
  } {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const bus = {
      on(event: string, handler: (data: unknown) => void): () => void {
        const handlers = listeners.get(event) ?? new Set<(data: unknown) => void>();
        handlers.add(handler);
        listeners.set(event, handlers);
        return () => handlers.delete(handler);
      },
      emit(event: string, data: unknown): void {
        for (const handler of listeners.get(event) ?? []) handler(data);
      },
    };
    bus.on("subagents:rpc:context", (raw) => {
      const { requestId } = raw as { requestId: string };
      bus.emit(`subagents:rpc:context:reply:${requestId}`, {
        success: true,
        data: { child: false, capability: "childContext" },
      });
    });
    bus.on("subagents:rpc:ping", (raw) => {
      const { requestId } = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${requestId}`, {
        success: true,
        // A host with no reachable catalogue answers below the negotiated
        // version, which is how the command loses the tier list mid-session.
        data: policy
          ? {
              version: PROTOCOL_VERSION,
              capabilities: PROTOCOL_CAPABILITIES,
              routingPolicy: {
                policy,
                fingerprint: routingPolicyFingerprint(policy),
              },
            }
          : { version: PROTOCOL_VERSION - 1, capabilities: {} },
      });
    });
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const lifecycle = new Map<string, (...args: never[]) => unknown>();
    const pi = {
      events: bus,
      appendEntry: () => {},
      registerTool: () => {},
      registerCommand: (name: string, descriptor: unknown) => {
        commands.set(
          name,
          descriptor as {
            handler: (args: string, ctx: unknown) => Promise<void>;
          },
        );
      },
      on: (event: string, handler: (...args: never[]) => unknown) => {
        lifecycle.set(event, handler);
        return () => lifecycle.delete(event);
      },
      ui: { setWidget: () => {} },
    };
    const ctx = {
      hasUI: false,
      mode: "print" as const,
      cwd: projectDir,
      sessionManager: { getBranch: () => [] },
    };
    piWorkflows(pi as never);
    const started = lifecycle.get("session_start")?.({} as never, ctx as never);
    return {
      run: async (args: string) => {
        await started;
        await new Promise((resolve) => setImmediate(resolve));
        const command = commands.get("workflows");
        if (!command) throw new Error("/workflows was not registered");
        const notices: string[] = [];
        await command.handler(`strength ${args}`.trim(), {
          ...ctx,
          ui: { notify: (message: string) => notices.push(message) },
        });
        return notices;
      },
      shutdown: async () => {
        await lifecycle.get("session_shutdown")?.({} as never, ctx as never);
      },
    };
  }

  /** What the project file actually holds, which is what the next session reads. */
  function projectFile(): Record<string, unknown> | undefined {
    try {
      return JSON.parse(readFileSync(loadProjectSettingsPath(agentDir, projectDir), "utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  it("shows the shipped default and the host's own tiers in one view", async () => {
    // The two halves have different owners, and this is the only place both are
    // visible. An unconfigured machine is routed, not unrouted — on this host
    // the default binds nothing, because it is identity only where the host
    // defines the name.
    const host = activate(HOST_POLICY);
    const [notice] = await host.run("");
    expect(notice).toContain("low → (unset; the agent's own default)");
    expect(notice).toContain("Tiers this host defines: cheap, standard");
    expect(projectFile()).toBeUndefined();
    await host.shutdown();
  });

  it("writes a mapping and reports the resolved table, not the write", async () => {
    const host = activate(HOST_POLICY);
    const [notice] = await host.run("low cheap");
    expect(notice).toContain("low → cheap");
    expect(projectFile()).toEqual({ strengths: { low: "cheap" } });
    await host.shutdown();
  });

  it("refuses a target this host does not define, and writes nothing", async () => {
    // The catalogue belongs to pi-subagents, so the command can only point at
    // what is already there — and says where to add one.
    const host = activate(HOST_POLICY);
    const [notice] = await host.run("low deep");
    expect(notice).toContain('"deep" is not a tier this host defines');
    expect(notice).toContain("cheap, standard");
    expect(projectFile()).toBeUndefined();
    await host.shutdown();
  });

  it("refuses a word outside the vocabulary, the way the runtime does", async () => {
    const host = activate(HOST_POLICY);
    const [notice] = await host.run("large cheap");
    expect(notice).toContain('"large" is not a workflow strength');
    expect(projectFile()).toBeUndefined();
    await host.shutdown();
  });

  it("clears one mapping with `off` and leaves the others standing", async () => {
    const host = activate(HOST_POLICY);
    await host.run("low cheap");
    await host.run("high standard");
    expect(projectFile()).toEqual({
      strengths: { low: "cheap", high: "standard" },
    });

    const [notice] = await host.run("low off");
    expect(notice).toContain("low → (unset; the agent's own default)");
    expect(notice).toContain("high → standard");
    expect(projectFile()).toEqual({ strengths: { high: "standard" } });
    await host.shutdown();
  });

  it("seeds from the table a run would use, so one edit cannot discard an inherited one", async () => {
    // The key replaces rather than merges at every level. Built on this
    // project's own file, setting `high` would have written a one-entry table
    // and silently unmapped the global `low`.
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    writeFileSync(
      join(agentDir, "workflows", "settings.json"),
      JSON.stringify({ strengths: { low: "cheap", medium: "standard" } }),
    );
    const host = activate(HOST_POLICY);
    const [notice] = await host.run("high standard");
    expect(projectFile()).toEqual({
      strengths: { low: "cheap", medium: "standard", high: "standard" },
    });
    expect(notice).toContain("low → cheap");
    await host.shutdown();
  });

  it("names the machine-wide table, which the command itself cannot write", async () => {
    // The command only ever writes project scope, so the one thing a user who
    // wants a machine-wide table needs is the path — and it was the one thing
    // the view did not say.
    const host = activate(HOST_POLICY);
    const [notice] = await host.run("");
    expect(notice).toContain("Edits apply to this project");
    expect(notice).toContain("<agent dir>/workflows/settings.json");
    await host.shutdown();
  });

  it("says the shipped default still shares the tiers ordinary spawns use", async () => {
    // The default is identity, so an unconfigured machine has the coupling this
    // whole indirection exists to let you break. Making that expressible is not
    // the same as breaking it, and the two steps out of it live in two packages.
    const identityHost: ManagedRoutingPolicy = {
      defaultTier: "medium",
      profiles: {
        low: { model: "inherit", thinking: "low" },
        medium: { model: "inherit", thinking: "medium" },
      },
      blockedProfiles: [],
      blockedDefaultTier: false,
    };
    const host = activate(identityHost);
    const [shippedNotice] = await host.run("");
    expect(shippedNotice).toContain("low → low (default)");
    expect(shippedNotice).toContain("This is the shipped default");
    expect(shippedNotice).toContain("Explore");

    // Once a table is written the note is gone: the machine is no longer on the
    // default, so describing one would be describing something else.
    const [configuredNotice] = await host.run("low medium");
    expect(configuredNotice).not.toContain("This is the shipped default");
    await host.shutdown();
  });

  it("says which reading won when the host defines a tier named `off`", async () => {
    // The catalogue outranks our keyword — a tier you cannot point at is worse
    // than a clumsier way to clear one — but a user who typed the documented
    // keyword and got a mapping has to be told, and told where the other
    // reading lives.
    const offHost: ManagedRoutingPolicy = {
      defaultTier: "standard",
      profiles: {
        off: { model: "inherit", thinking: "low" },
        standard: { model: "inherit", thinking: "medium" },
      },
      blockedProfiles: [],
      blockedDefaultTier: false,
    };
    const host = activate(offHost);
    const [notice] = await host.run("low off");
    expect(notice).toContain("low → off");
    expect(notice).toContain('this host defines a tier named "off"');
    expect(projectFile()).toEqual({ strengths: { low: "off" } });
    await host.shutdown();
  });

  it("refuses to set anything while the tier catalogue is unreachable", async () => {
    // Seeding from a default it cannot compute would write a one-entry table,
    // and this key replaces rather than merges — so the other two strengths
    // would go from routed to unmapped as a side effect of setting this one.
    const host = activate(undefined);
    const [notice] = await host.run("low cheap");
    expect(notice).toContain("tier catalogue is unavailable");
    expect(projectFile()).toBeUndefined();

    // Status still has the two halves it owns; only the host's list is missing.
    const [status] = await host.run("");
    expect(status).toContain("Tiers this host defines: (unavailable)");
    await host.shutdown();
  });
});

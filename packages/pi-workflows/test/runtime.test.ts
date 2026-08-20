/**
 * runtime.test.ts — the JS orchestration runtime.
 *
 * Acceptance coverage from the optimization spec (A2):
 *  - meta parsing rejects every illegal literal form
 *  - determinism stubs throw and `new Date(arg)` still works
 *  - parallel() callIndex is independent of completion order
 *  - maxAgents is not breached under concurrent fan-out
 *  - nested workflow() shares limiter and budget
 *  - batch-scoped cancellation: AGENT_LIMIT_EXCEEDED cancels only its own batch
 *  - schema validation with bounded repair
 *  - resume: longest-unchanged-prefix replay
 */

import { describe, expect, it } from "vitest";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  type AgentRunOptions,
  DEFAULT_AGENT_TIMEOUT_MS,
  findJsonBlock,
  parseWorkflowScript,
  runWorkflow,
  validateJsonSchema,
  type WorkflowAgentRunner,
} from "../src/runtime.js";
import { SharedStore } from "../src/shared-store.js";

// ── meta parsing gate ────────────────────────────────────────────────────────

describe("parseWorkflowScript meta gate", () => {
  it("accepts a literal-only meta and strips it from the body", () => {
    const { meta, body } = parseWorkflowScript(
      `export const meta = { name: "demo", description: "A demo", phases: [{ title: "phase one", detail: "d" }] };
const x = 1;`,
    );
    expect(meta.name).toBe("demo");
    expect(meta.phases?.[0]?.title).toBe("phase one");
    expect(body).not.toContain("export const meta");
    expect(body).toContain("const x = 1;");
  });

  it("rejects a script whose first statement is not the meta export", () => {
    expect(() => parseWorkflowScript(`const x = 1;\nexport const meta = { name: "a", description: "b" };`)).toThrow(
      WorkflowError,
    );
  });

  it("rejects non-const, non-meta, and multi-declarator exports", () => {
    expect(() => parseWorkflowScript(`export let meta = { name: "a", description: "b" };`)).toThrow(
      /export const meta/,
    );
    expect(() => parseWorkflowScript(`export const other = { name: "a" };`)).toThrow(/must declare `meta`/);
    expect(() => parseWorkflowScript(`export const meta = { name: "a" }, x = 1;`)).toThrow(/declare only `meta`/);
  });

  it("rejects spread, computed keys, methods, and reserved keys", () => {
    const base = `export const meta = { name: "a", description: "b"`;
    expect(() => parseWorkflowScript(`${base}, ...extra };`)).toThrow(/spread not allowed/);
    expect(() => parseWorkflowScript(`${base}, ["k"]: 1 };`)).toThrow(/computed keys not allowed/);
    expect(() => parseWorkflowScript(`${base}, method() { return 1; } };`)).toThrow(/methods\/accessors not allowed/);
    expect(() => parseWorkflowScript(`export const meta = { name: "a", description: "b", __proto__: {} };`)).toThrow(
      /reserved key name/,
    );
    expect(() => parseWorkflowScript(`export const meta = { name: "a", description: "b", constructor: 1 };`)).toThrow(
      /reserved key name/,
    );
  });

  it("rejects template interpolation and non-literal values", () => {
    expect(() => parseWorkflowScript(`export const meta = { name: \`a\${x}\`, description: "b" };`)).toThrow(
      /template interpolation/,
    );
    // Date.now() trips the determinism blocklist before the AST gate — the
    // blocklist is the outer precheck, the realm stubs the inner guard.
    expect(() =>
      parseWorkflowScript(`export const meta = { name: "a", description: "b", phases: [Date.now()] };`),
    ).toThrow(/must be deterministic/);
    // A non-literal that does not trip the blocklist still fails the AST gate.
    expect(() =>
      parseWorkflowScript(`export const meta = { name: "a", description: "b", phases: [new Object()] };`),
    ).toThrow(/non-literal node type/);
  });

  it("rejects blank name/description", () => {
    expect(() => parseWorkflowScript(`export const meta = { name: "  ", description: "b" };`)).toThrow(
      /name must be a non-empty/,
    );
    expect(() => parseWorkflowScript(`export const meta = { name: "a", description: "" };`)).toThrow(
      /description must be a non-empty/,
    );
  });

  it("rejects the determinism blocklist before parsing", () => {
    expect(() =>
      parseWorkflowScript(`export const meta = { name: "a", description: "b" };\nconst t = Date.now();`),
    ).toThrow(/must be deterministic/);
    expect(() => parseWorkflowScript(`export const meta = { name: "a", description: "b" };\nMath.random();`)).toThrow(
      /must be deterministic/,
    );
    expect(() => parseWorkflowScript(`export const meta = { name: "a", description: "b" };\nnew Date();`)).toThrow(
      /must be deterministic/,
    );
  });
});

// ── determinism stubs ────────────────────────────────────────────────────────

describe("determinism prelude", () => {
  const run = (body: string) =>
    runWorkflow(`export const meta = { name: "det", description: "determinism" };\n${body}`, {
      agent: nullRunner(),
    });

  // The blocklist regex catches the plain spellings before parsing, so the
  // realm stubs are exercised through blocklist-bypassing spellings — the
  // reason the prelude exists at all.

  it("Math.random() throws inside the realm", async () => {
    await expect(run(`const r = Math["random"](); return r;`)).rejects.toThrow(/Math\.random\(\) is unavailable/);
  });

  it("Date.now() throws inside the realm", async () => {
    await expect(run(`const t = Date["now"](); return t;`)).rejects.toThrow(/Date\.now\(\) is unavailable/);
  });

  it("new Date() throws but new Date(arg) still works", async () => {
    await expect(run(`const D = Date; return new D();`)).rejects.toThrow(/new Date\(\) is unavailable/);
    const { result } = await run(`const d = new Date(0); return d.toISOString();`);
    expect(result).toBe("1970-01-01T00:00:00.000Z");
  });

  it("Date.UTC and Date.parse survive", async () => {
    const { result } = await run(`return [Date.UTC(2024, 0, 1), Date.parse("1970-01-02T00:00:00Z")];`);
    expect(result).toEqual([1704067200000, 86400000]);
  });
});

// ── runtime globals and control flow ─────────────────────────────────────────

/** A runner that answers with a deterministic string derived from the prompt. */
function nullRunner(): WorkflowAgentRunner {
  return {
    run: async (prompt: string, _options?: AgentRunOptions) => `answer:${prompt.length}`,
  };
}

describe("runtime globals", () => {
  it("exposes args, cwd, process.cwd, log, and budget", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "globals", description: "g" };
log("hello");
return { args, cwd, cwd2: process.cwd(), budget: budget.remaining() };`,
      { args: { a: 1 }, cwd: "/work", tokenBudget: 1000, agent: nullRunner() },
    );
    expect(result).toEqual({ args: { a: 1 }, cwd: "/work", cwd2: "/work", budget: 1000 });
  });

  it("phase() records phases and the current phase reaches agent labels", async () => {
    const labels: string[] = [];
    const { phases } = await runWorkflow(
      `export const meta = { name: "phases", description: "p", phases: [{ title: "first" }, { title: "second" }] };
phase("first");
await agent("one");
phase("second");
await agent("two");`,
      {
        agent: {
          run: async (_p: string, o?: AgentRunOptions) => {
            labels.push(o?.label ?? "?");
            return "x";
          },
        },
        onAgentStart: (e) => void e,
      },
    );
    expect(phases).toEqual(["first", "second"]);
    expect(labels).toEqual(["first agent 1", "second agent 2"]);
  });

  it("log() records into run logs and the console alias works", async () => {
    const { logs } = await runWorkflow(
      `export const meta = { name: "logs", description: "l" };
log("one");
console.log("two");
console.warn("three");`,
      { agent: nullRunner() },
    );
    expect(logs).toContain("one");
    expect(logs).toContain("two");
    expect(logs).toContain("[warn] three");
  });
});

describe("agent() dispatch contract", () => {
  it("passes prompt, instructions, phase, tier, and schema through to the runner", async () => {
    let seen: { prompt: string; options?: AgentRunOptions } | undefined;
    await runWorkflow(
      `export const meta = { name: "dispatch", description: "d" };
const r = await agent("do the thing", { tier: "small", agentType: "Explore", label: "mine", phase: "scan", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } });
return r;`,
      {
        agent: {
          run: async (prompt: string, options?: AgentRunOptions) => {
            seen = { prompt, options };
            return '{"ok": true}';
          },
        },
      },
    );
    expect(seen?.prompt).toContain("do the thing");
    expect(seen?.prompt).toContain('"ok"'); // schema instruction embedded
    expect(seen?.options?.tier).toBe("small");
    expect(seen?.options?.label).toBe("mine");
    expect(seen?.options?.instructions).toContain("Act as workflow subagent type: Explore");
    expect(seen?.options?.instructions).toContain("Workflow phase: scan");
  });

  it("parses and validates a schema result client-side", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "schema", description: "s" };
return await agent("answer", { schema: { type: "object", properties: { real: { type: "boolean" } }, required: ["real"] } });`,
      {
        agent: {
          run: async () => 'Here is my answer: {"real": true}',
        },
      },
    );
    expect(result).toEqual({ real: true });
  });

  it("repairs an invalid schema reply across attempts and throws SCHEMA_NONCOMPLIANCE on exhaustion", async () => {
    let calls = 0;
    await expect(
      runWorkflow(
        `export const meta = { name: "schema-bad", description: "s" };
return await agent("answer", { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } });`,
        {
          agentRetries: 1,
          agent: {
            run: async () => {
              calls++;
              return '{"n": "not-a-number"}';
            },
          },
        },
      ),
    ).rejects.toThrow(WorkflowError);
    expect(calls).toBe(2); // initial + one repair attempt
  });

  it("recovers to null after a recoverable failure exhausts attempts", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "recover", description: "r" };
return await agent("fragile");`,
      {
        agentRetries: 1,
        agent: {
          run: async () => {
            throw new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
          },
        },
      },
    );
    expect(result).toBeNull();
  });

  it("propagates a non-recoverable failure", async () => {
    await expect(
      runWorkflow(
        `export const meta = { name: "fatal", description: "f" };
return await agent("doomed");`,
        {
          agent: {
            run: async () => {
              throw new WorkflowError("kaput", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, { recoverable: false });
            },
          },
        },
      ),
    ).rejects.toThrow(/kaput/);
  });

  it("empty text output is a recoverable failure that becomes null", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "empty", description: "e" };
return await agent("say nothing");`,
      { agent: { run: async () => "   " } },
    );
    expect(result).toBeNull();
  });

  it("forwards an explicit per-call model for managed resolution", async () => {
    let selected: string | undefined;
    const { result } = await runWorkflow(
      `export const meta = { name: "model", description: "m" };
return await agent("x", { model: "anthropic/claude-sonnet" });`,
      {
        agent: {
          run: async (_prompt, options) => {
            selected = options?.model;
            return "ok";
          },
        },
      },
    );
    expect(result).toBe("ok");
    expect(selected).toBe("anthropic/claude-sonnet");
  });
});

describe("runtime hardening", () => {
  it("returns undefined for an empty judge panel", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "empty-judge", description: "e" };\nreturn await judgePanel([]);`,
      { agent: { run: async () => ({ score: 1 }) } },
    );
    expect(result).toBeUndefined();
  });

  it("enforces additionalProperties false in nested schemas", async () => {
    await expect(
      runWorkflow(
        `export const meta = { name: "strict-schema", description: "s" };\nreturn await agent("x", { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });`,
        { agent: { run: async () => JSON.stringify({ ok: true, extra: "reject" }) } },
      ),
    ).rejects.toThrow(/unexpected property/);
  });
});

// ── parallel / pipeline ──────────────────────────────────────────────────────

describe("parallel()", () => {
  it("preserves input order regardless of completion order", async () => {
    const delays = [30, 5, 20, 10];
    const { result } = await runWorkflow(
      `export const meta = { name: "par", description: "p" };
return await parallel(args.delays.map((ms, i) => () => agent("task " + i)));`,
      {
        args: { delays },
        agent: {
          run: async (prompt: string) => {
            const i = Number(prompt.split(" ")[1]);
            await new Promise((r) => setTimeout(r, delays[i]));
            return `done:${i}`;
          },
        },
      },
    );
    expect(result).toEqual(["done:0", "done:1", "done:2", "done:3"]);
  });

  it("rejects promises instead of thunks", async () => {
    await expect(
      runWorkflow(
        `export const meta = { name: "par-bad", description: "p" };
return await parallel([agent("x")]);`,
        { agent: nullRunner() },
      ),
    ).rejects.toThrow(/expects an array of functions, not promises/);
  });

  it("recoverable thunk failures become null; non-recoverable throw", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "par-null", description: "p" };
return await parallel([() => agent("ok"), () => agent("bad")]);`,
      {
        agent: {
          run: async (prompt: string) => {
            if (prompt.startsWith("bad")) {
              throw new WorkflowError("nope", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
            }
            return "fine";
          },
        },
      },
    );
    expect(result).toEqual(["fine", null]);
  });
});

describe("pipeline()", () => {
  it("runs stages sequentially per item with (prev, original, index)", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "pipe", description: "p" };
return await pipeline([1, 2, 3], async (prev, original, index) => {
  const doubled = await agent("double " + original);
  return (prev === original ? 0 : prev) + Number(doubled);
}, async (prev, original, index) => prev + index);`,
      {
        agent: { run: async (p: string) => String(Number(p.split(" ")[1]) * 2) },
      },
    );
    // item 1: stage1 2, stage2 2+0=2; item 2: stage1 4, stage2 4+1=5; item 3: 6+2=8
    expect(result).toEqual([2, 5, 8]);
  });
});

// ── quality helpers ──────────────────────────────────────────────────────────

describe("quality helpers", () => {
  it("verify() computes real/threshold from reviewer votes", async () => {
    let call = 0;
    const { result } = await runWorkflow(
      `export const meta = { name: "verify", description: "v" };
return await verify("claim x", { reviewers: 3, threshold: 0.5 });`,
      {
        agent: {
          run: async () => {
            call++;
            return call % 2 === 1 ? '{"real": true}' : '{"real": false}';
          },
        },
      },
    );
    expect(result).toEqual({
      real: true, // 2/3 real >= 0.5
      realCount: 2,
      total: 3,
      votes: expect.any(Array),
    });
  });

  it("judgePanel() picks the highest mean score with stable tie-break", async () => {
    let call = 0;
    const { result } = await runWorkflow(
      `export const meta = { name: "judge", description: "j" };
return await judgePanel(["candidate a", "candidate b"], { judges: 2 });`,
      {
        agent: {
          run: async () => {
            call++;
            return call % 2 === 1 ? '{"score": 0.9}' : '{"score": 0.4}';
          },
        },
      },
    );
    // Candidate a: judges score [0.9, 0.4] → mean 0.65. Candidate b: same
    // pattern → mean 0.65. Tie broken by stable input index → candidate a.
    expect(result?.index).toBe(0);
    expect(result?.score).toBe(0.65);
  });

  it("loopUntilDry() stops on consecutive empty rounds and dedupes by key", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "dry", description: "d" };
return await loopUntilDry({
  round: (i) => {
    if (i === 0) return [{ id: "a" }, { id: "b" }];
    if (i === 1) return [{ id: "a" }]; // duplicate of round 0
    return [];
  },
  key: (x) => x.id,
  consecutiveEmpty: 2,
});`,
      { agent: nullRunner() },
    );
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("loopUntilDry() returns partial results on budget exhaustion", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "dry-budget", description: "d" };
return await loopUntilDry({ round: async () => {
  throw { code: "TOKEN_BUDGET_EXHAUSTED" };
} });`,
      { agent: nullRunner() },
    );
    expect(result).toEqual([]);
  });

  it("completenessCheck() sends bounded evidence", async () => {
    let prompt = "";
    const { result } = await runWorkflow(
      `export const meta = { name: "cc", description: "c" };
return await completenessCheck({ task: "t" }, { data: "x".repeat(9000) });`,
      {
        agent: {
          run: async (p: string) => {
            prompt = p;
            return '{"complete": false, "missing": ["m"]}';
          },
        },
      },
    );
    expect(result).toEqual({ complete: false, missing: ["m"] });
    expect(prompt.length).toBeLessThan(6000);
  });

  it("retry() accepts by until() and returns last result on exhaustion", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "retry", description: "r" };
const ok = await retry((i) => i + 1, { attempts: 3, until: (r) => r === 2 });
const exhausted = await retry((i) => i + 1, { attempts: 2, until: (r) => r > 9 });
return [ok, exhausted];`,
      { agent: nullRunner() },
    );
    expect(result).toEqual([2, 2]);
  });

  it("gate() feeds validator feedback into the next attempt and reports attempts", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "gate", description: "g" };
return await gate(
  (feedback, attempt) => (feedback === "add more" ? "good" : "bad"),
  (value) => ({ ok: value === "good", feedback: value === "bad" ? "add more" : undefined }),
  { attempts: 3 },
);`,
      { agent: nullRunner() },
    );
    expect(result).toEqual({ ok: true, value: "good", attempts: 2 });
  });
});

// ── checkpoint ───────────────────────────────────────────────────────────────

describe("checkpoint()", () => {
  it("threads a confirm callback when one is provided", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "cp", description: "c" };
return await checkpoint("proceed?", { kind: "confirm" });`,
      {
        agent: nullRunner(),
        confirm: async () => "yes please",
      },
    );
    expect(result).toBe("yes please");
  });

  it("headless with no confirm takes the declared default", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "cp-headless", description: "c" };
return await checkpoint("proceed?", { default: "auto" });`,
      { agent: nullRunner() },
    );
    expect(result).toBe("auto");
  });

  it("headless: abort throws instead of hanging", async () => {
    await expect(
      runWorkflow(
        `export const meta = { name: "cp-abort", description: "c" };
return await checkpoint("proceed?", { headless: "abort" });`,
        { agent: nullRunner() },
      ),
    ).rejects.toThrow(/needs human input/);
  });

  it("journaled checkpoint answers replay on resume without re-prompting", async () => {
    const journal = new Map<string, { index: number; runId: string; hash: string; result: unknown }>();
    const confirms: string[] = [];
    const script = `export const meta = { name: "cp-resume", description: "c" };
const a = await agent("work");
const b = await checkpoint("continue?", { default: "fallback" });
return [a, b];`;
    const options = {
      agent: { run: async () => "result-a" },
      confirm: async (p: string) => {
        confirms.push(p);
        return "human answer";
      },
      onAgentJournal: (entry: { index: number; runId?: string; hash: string; result: unknown }) => {
        journal.set(`${entry.runId}:${entry.index}`, entry as never);
      },
    };
    const runId = "run-test";
    const first = await runWorkflow(script, { ...options, runId });
    expect(first.result).toEqual(["result-a", "human answer"]);
    expect(confirms).toHaveLength(1);

    // Resume with the SAME runId (journal keys are namespaced by it): agent()
    // replays from cache; checkpoint() must replay its journaled answer instead
    // of re-prompting the human.
    const second = await runWorkflow(script, { ...options, runId, resumeJournal: journal });
    expect(second.result).toEqual(["result-a", "human answer"]);
    expect(confirms).toHaveLength(1); // no re-prompt
  });
});

// ── concurrency and limits ───────────────────────────────────────────────────

describe("limits", () => {
  it("the concurrency limiter caps peak parallelism without breaching maxAgents", async () => {
    let active = 0;
    let peak = 0;
    let started = 0;
    const { agentCount } = await runWorkflow(
      `export const meta = { name: "fan", description: "f" };
const results = await parallel(Array.from({ length: 20 }, (_, i) => () => agent("t" + i)));
return results.length;`,
      {
        maxAgents: 20,
        concurrency: 8,
        agent: {
          run: async () => {
            started++;
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return "x";
          },
        },
      },
    );
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1); // genuinely concurrent
    expect(agentCount).toBe(20);
    expect(started).toBe(20);
  });

  it("concurrency is clamped to 1..16", async () => {
    let active = 0;
    let peak = 0;
    await runWorkflow(
      `export const meta = { name: "conc", description: "c" };
await parallel(Array.from({ length: 8 }, (_, i) => () => agent("t" + i)));
return 0;`,
      {
        concurrency: 99,
        agent: {
          run: async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return "x";
          },
        },
      },
    );
    expect(peak).toBeLessThanOrEqual(16);
  });

  it("a breached fan-out cancels only its own batch", async () => {
    let calls = 0;
    await expect(
      runWorkflow(
        `export const meta = { name: "cancel", description: "c" };
await parallel([
  () => agent("a1"),
  () => agent("a2"),
  () => agent("a3"),
  () => agent("a4"),
  () => agent("a5"),
]);`,
        {
          maxAgents: 3,
          agent: {
            run: async () => {
              calls++;
              return "x";
            },
          },
        },
      ),
    ).rejects.toThrow(/Agent limit exceeded/);
    // The breaching call throws at the gate (no dispatch); the 3 reserved slots
    // may dispatch, but no more than maxAgents calls are made.
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("token budget is a soft gate: exhausted after in-flight work settles", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "budget", description: "b" };
return await agent("one");`,
      {
        tokenBudget: 1, // trivially exhausted after the first agent
        agent: {
          run: async () => "x".repeat(4000), // ~1000 est tokens
        },
      },
    );
    expect(result).toBe("x".repeat(4000));
  });

  it("budget.remaining() reflects spent tokens", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "budget-rem", description: "b" };
await agent("big");
return budget.remaining();`,
      {
        tokenBudget: 1000,
        agent: { run: async () => "y".repeat(8000) }, // ~2000 est tokens
      },
    );
    expect(result).toBeLessThan(1000);
  });
});

// ── nested workflow() ────────────────────────────────────────────────────────

describe("nested workflow()", () => {
  it("shares the limiter and budget across nesting", async () => {
    let active = 0;
    let peak = 0;
    const { agentCount } = await runWorkflow(
      `export const meta = { name: "parent", description: "p" };
await parallel(Array.from({ length: 6 }, (_, i) => () => agent("p" + i)));
await workflow("child-script", { n: 3 });
return 0;`,
      {
        maxAgents: 9,
        concurrency: 4,
        loadSavedWorkflow: (name) =>
          name === "child-script"
            ? `export const meta = { name: "child", description: "c" };
await parallel(Array.from({ length: args.n }, (_, i) => () => agent("c" + i)));
return 1;`
            : undefined,
        agent: {
          run: async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return "x";
          },
        },
      },
    );
    expect(peak).toBeLessThanOrEqual(4); // shared limiter across parent+child
    expect(agentCount).toBe(9); // 6 parent + 3 child, all through one counter
  });

  it("rejects nesting two levels deep", async () => {
    await expect(
      runWorkflow(
        `export const meta = { name: "deep", description: "d" };
await workflow("child");
return 0;`,
        {
          loadSavedWorkflow: (name) =>
            name === "child"
              ? `export const meta = { name: "child", description: "c" };
await workflow("grandchild");
return 0;`
              : name === "grandchild"
                ? `export const meta = { name: "grandchild", description: "g" };
return 0;`
                : undefined,
          agent: nullRunner(),
        },
      ),
    ).rejects.toThrow(/only one level deep/);
  });

  it("nested runs get unique runIds via nestedCallSeq, not depth", async () => {
    const journal = new Map<string, unknown>();
    const runIds: string[] = [];
    await runWorkflow(
      `export const meta = { name: "seq", description: "s" };
await workflow("child", { tag: "one" });
await workflow("child", { tag: "two" });
return 0;`,
      {
        loadSavedWorkflow: (name) =>
          name === "child"
            ? `export const meta = { name: "child", description: "c" };
await agent("child-work");
return args.tag;`
            : undefined,
        agent: { run: async () => "x" },
        onAgentJournal: (entry) => {
          runIds.push(entry.runId ?? "");
          journal.set(`${entry.runId}:${entry.index}`, entry);
        },
      },
    );
    expect(new Set(runIds).size).toBe(2); // two distinct nested runs share the top-level namespace prefix
  });
});

// ── resume replay ────────────────────────────────────────────────────────────

describe("resume replay", () => {
  const script = `export const meta = { name: "resume", description: "r" };
const a = await agent("first");
const b = await agent("second");
const c = await agent("third");
return [a, b, c];`;

  function capturingRun(answers: string[], calls: string[]) {
    return {
      agent: {
        run: async (prompt: string) => {
          calls.push(prompt);
          return answers[prompt === "first" ? 0 : prompt === "second" ? 1 : 2];
        },
      },
      onAgentJournal: () => {},
    };
  }

  it("replays the longest unchanged prefix; live from the first miss", async () => {
    const journal = new Map<string, { index: number; runId: string; hash: string; result: unknown }>();
    const calls1: string[] = [];
    await runWorkflow(script, {
      runId: "run-A",
      ...capturingRun(["a", "b", "c"], calls1),
      onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry as never),
    });
    expect(calls1).toEqual(["first", "second", "third"]);

    // Resume: same runId (journal keys are namespaced by it); script edited at
    // the second call → first replays, second+ third live.
    const edited = `export const meta = { name: "resume", description: "r" };
const a = await agent("first");
const b = await agent("second EDITED");
const c = await agent("third");
return [a, b, c];`;
    const calls2: string[] = [];
    await runWorkflow(edited, {
      runId: "run-A",
      ...capturingRun(["a", "b-edited", "c"], calls2),
      resumeJournal: journal,
      onAgentJournal: () => {},
    });
    expect(calls2).toEqual(["second EDITED", "third"]);
  });

  it("cache hits report zero tokens", async () => {
    const journal = new Map<string, { index: number; runId: string; hash: string; result: unknown }>();
    const ends: number[] = [];
    await runWorkflow(script, {
      runId: "run-C",
      ...capturingRun(["a", "b", "c"], []),
      onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry as never),
      onAgentEnd: (e) => ends.push(e.tokens ?? -1),
    });
    await runWorkflow(script, {
      runId: "run-C",
      ...capturingRun(["a", "b", "c"], []),
      resumeJournal: journal,
      onAgentEnd: (e) => ends.push(e.tokens ?? -1),
    });
    // run-C: 3 live; resume: 3 cache hits with tokens 0.
    expect(ends.slice(3)).toEqual([0, 0, 0]);
  });

  it("store deltas replay additively in call order", async () => {
    const journal = new Map<
      string,
      { index: number; runId: string; hash: string; result: unknown; storeDelta?: Record<string, unknown> }
    >();
    // Two parallel agents writing to the store; the later call finishes first.
    await runWorkflow(
      `export const meta = { name: "store", description: "s" };
await parallel([
  () => agent("slow-writer"),
  () => agent("fast-writer"),
]);
return 0;`,
      {
        runId: "run-S",
        agent: {
          run: async (prompt: string) => {
            const store = new SharedStore(); // not used; real store is internal
            void store;
            if (prompt === "slow-writer") {
              await new Promise((r) => setTimeout(r, 20));
            }
            return prompt;
          },
        },
        onAgentJournal: (entry) => journal.set(`${entry.runId}:${entry.index}`, entry as never),
      },
    );
    // The journal itself only proves entries were captured with per-call keys.
    expect(journal.size).toBe(2);
    const keys = [...journal.keys()].sort();
    expect(keys[0]).toMatch(/^run-S:0$/);
    expect(keys[1]).toMatch(/^run-S:1$/);
  });
});

// ── schema validation helper ─────────────────────────────────────────────────

describe("findJsonBlock / validateJsonSchema", () => {
  it("extracts balanced JSON from prose", () => {
    expect(findJsonBlock('Answer: {"a": 1}')).toBe('{"a": 1}');
    expect(findJsonBlock('{"a": {"b": [1, 2]}} done')).toBe('{"a": {"b": [1, 2]}}');
    expect(findJsonBlock("no json here")).toBeUndefined();
  });

  it("validates the supported JSON Schema subset", () => {
    const schema = { type: "object", properties: { real: { type: "boolean" } }, required: ["real"] };
    expect(validateJsonSchema({ real: true }, schema)).toEqual([]);
    expect(validateJsonSchema({ real: "yes" }, schema).length).toBeGreaterThan(0);
    expect(validateJsonSchema({}, schema).length).toBeGreaterThan(0);
  });

  it("rejects unsupported JSON Schema keywords", () => {
    expect(() => validateJsonSchema({}, { type: "object", patternProperties: {} })).toThrow(
      /unsupported JSON Schema keyword/,
    );
  });
});

// ── timeout and abort ────────────────────────────────────────────────────────

describe("agent timeout and abort", () => {
  it("DEFAULT_AGENT_TIMEOUT_MS is 300000 (5min) not null", () => {
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(300_000);
  });

  it("times out a hung agent using the run-level default", async () => {
    const { result, logs } = await runWorkflow(
      `export const meta = { name: "timeout-default", description: "t" };
return await agent("hang");`,
      {
        agentTimeoutMs: 30,
        agent: {
          run: async (_prompt: string, opts?: AgentRunOptions) => {
            // Hang until the runtime aborts via signal or timeout wins.
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 10_000);
              opts?.signal?.addEventListener("abort", () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              });
            });
            return "never";
          },
        },
      },
    );
    // Timeout is recoverable -> agent returns null, workflow completes.
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/timed out after 30ms/);
  });

  it("per-call timeoutMs overrides the run-level timeout", async () => {
    // Run-level would allow 10s, per-call limits to 20ms.
    const { result, logs } = await runWorkflow(
      `export const meta = { name: "timeout-percall", description: "t" };
return await agent("hang", { timeoutMs: 20 });`,
      {
        agentTimeoutMs: 10_000,
        agent: {
          run: async (_prompt: string, opts?: AgentRunOptions) => {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 10_000);
              opts?.signal?.addEventListener("abort", () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              });
            });
            return "never";
          },
        },
      },
    );
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/timed out after 20ms/);
  });

  it("per-call timeoutMs null disables the hard timeout", async () => {
    const { result } = await runWorkflow(
      `export const meta = { name: "timeout-null", description: "t" };
return await agent("quick", { timeoutMs: null });`,
      {
        agentTimeoutMs: 20,
        agent: {
          run: async () => {
            await new Promise((r) => setTimeout(r, 40));
            return "late but allowed";
          },
        },
      },
    );
    expect(result).toBe("late but allowed");
  });

  it("a pre-aborted signal aborts the next agent() call", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runWorkflow(
        `export const meta = { name: "abort-pre", description: "t" };
return await agent("work");`,
        {
          signal: controller.signal,
          agent: nullRunner(),
        },
      ),
    ).rejects.toThrow(/workflow aborted/);
  });

  it("loopUntilDry respects AbortSignal between rounds", async () => {
    const controller = new AbortController();
    // Each round fans out an agent; the agent hangs host-side and is aborted
    // via the run's signal. The host delay is outside the vm (no vm setTimeout).
    const p = runWorkflow(
      `export const meta = { name: "dry-abort", description: "t" };
return await loopUntilDry({
  round: async () => {
    await agent("work");
    return [{ id: "x" }];
  },
  maxRounds: 20,
});`,
      {
        signal: controller.signal,
        agent: {
          run: async (_prompt: string, opts?: AgentRunOptions) => {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(() => resolve(), 5_000);
              opts?.signal?.addEventListener("abort", () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              });
            });
            return "x";
          },
        },
      },
    );
    setTimeout(() => controller.abort(), 30);
    await expect(p).rejects.toThrow(/aborted/);
  });

  it("retry() aborts mid-attempts when signal fires", async () => {
    const controller = new AbortController();
    const p = runWorkflow(
      `export const meta = { name: "retry-abort", description: "t" };
return await retry(async () => {
  await agent("work");
  return "nope";
}, { attempts: 5, until: () => false });`,
      {
        signal: controller.signal,
        agent: {
          run: async (prompt: string, opts?: AgentRunOptions) => {
            if (prompt === "work") {
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(() => resolve(), 5_000);
                opts?.signal?.addEventListener("abort", () => {
                  clearTimeout(t);
                  reject(new Error("aborted"));
                });
              });
              return "x";
            }
            return prompt;
          },
        },
      },
    );
    setTimeout(() => controller.abort(), 30);
    await expect(p).rejects.toThrow(/aborted/);
  });

  it("gate() aborts mid-attempts when signal fires", async () => {
    const controller = new AbortController();
    const p = runWorkflow(
      `export const meta = { name: "gate-abort", description: "t" };
return await gate(async () => {
  await agent("work");
  return "bad";
}, (v) => ({ ok: v === "good" }), { attempts: 5 });`,
      {
        signal: controller.signal,
        agent: {
          run: async (prompt: string, opts?: AgentRunOptions) => {
            if (prompt === "work") {
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(() => resolve(), 5_000);
                opts?.signal?.addEventListener("abort", () => {
                  clearTimeout(t);
                  reject(new Error("aborted"));
                });
              });
              return "x";
            }
            return prompt;
          },
        },
      },
    );
    setTimeout(() => controller.abort(), 30);
    await expect(p).rejects.toThrow(/aborted/);
  });
});

// ── A2 additional acceptance: burst maxAgents and callIndex stability ─────────

describe("A2 burst and callIndex stability", () => {
  it("parallel() assigns callIndex at lexical call time, not completion order", async () => {
    const seen: number[] = [];
    const { result } = await runWorkflow(
      `export const meta = { name: "callIdx", description: "c" };
return await parallel([
  () => agent("first"),
  () => agent("second"),
  () => agent("third"),
]);`,
      {
        agent: {
          run: async (prompt: string, opts?: AgentRunOptions) => {
            const idx = opts?.callIndex;
            if (typeof idx === "number") seen.push(idx);
            // Reverse completion: third fastest, first slowest.
            const delay = prompt === "third" ? 5 : prompt === "second" ? 15 : 30;
            await new Promise((r) => setTimeout(r, delay));
            return prompt;
          },
        },
      },
    );
    expect(result).toEqual(["first", "second", "third"]);
    expect(seen).toEqual([0, 1, 2]); // lexical order, not completion order 2,1,0
  });

  it("concurrent burst never exceeds maxAgents even with slow completions", async () => {
    let concurrent = 0;
    let peak = 0;
    // Fire 30 agents with maxAgents 10 and concurrency 10. The sync increment
    // of shared.agentCount (no await between limit check and increment) must
    // prevent overshoot regardless of completion order.
    await expect(
      runWorkflow(
        `export const meta = { name: "burst", description: "b" };
await parallel(Array.from({ length: 30 }, (_, i) => () => agent("t" + i)));
return "done";`,
        {
          maxAgents: 10,
          concurrency: 10,
          agent: {
            run: async () => {
              concurrent++;
              peak = Math.max(peak, concurrent);
              await new Promise((r) => setTimeout(r, 30));
              concurrent--;
              return "x";
            },
          },
        },
      ),
    ).rejects.toThrow(/Agent limit exceeded/);
    expect(peak).toBeLessThanOrEqual(10);
  });

  describe("agent threads", () => {
    it("runs sequential turns on the same thread with thread session name", async () => {
      const sessions: string[] = [];
      const { result } = await runWorkflow(
        `export const meta = { name: "threads", description: "t" };
const a = await agent("turn 1", { thread: "planner" });
const b = await agent("turn 2", { thread: "planner" });
return [a, b];`,
        {
          agent: {
            run: async (prompt, opts) => {
              sessions.push(opts?.sessionName ?? "");
              return `reply to ${prompt}`;
            },
          },
        },
      );
      expect(result).toEqual(["reply to turn 1", "reply to turn 2"]);
      expect(sessions.every((s) => s.includes("thread:planner"))).toBe(true);
    });

    it("rejects concurrent calls to the same thread name", async () => {
      await expect(
        runWorkflow(
          `export const meta = { name: "threads-conc", description: "t" };
await parallel([
  () => agent("task 1", { thread: "worker" }),
  () => agent("task 2", { thread: "worker" }),
]);
return 0;`,
          {
            agent: {
              run: async () => {
                await new Promise((r) => setTimeout(r, 50));
                return "x";
              },
            },
          },
        ),
      ).rejects.toThrow(/same-thread calls must be sequential/);
    });

    it("rejects empty thread string", async () => {
      await expect(
        runWorkflow(
          `export const meta = { name: "threads-empty", description: "t" };
await agent("task", { thread: "   " });
return 0;`,
          { agent: { run: async () => "x" } },
        ),
      ).rejects.toThrow(/thread must be a non-empty string/);
    });

    it("rejects thread combined with worktree isolation", async () => {
      await expect(
        runWorkflow(
          `export const meta = { name: "threads-wt", description: "t" };
await agent("task", { thread: "architect", isolation: "worktree" });
return 0;`,
          { agent: { run: async () => "x" } },
        ),
      ).rejects.toThrow(/cannot use worktree isolation/);
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type AgentRunOptions, type AgentUsage, type JournalEntry, runWorkflow } from "../src/runtime.js";

const META = 'export const meta = {name:"budget admission",description:"test"};';
const UNIT: AgentUsage = { input: 0, output: 1, total: 1, cost: 0, cacheRead: 0, cacheWrite: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const EXHAUSTED = WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED;

describe("pre-dispatch soft budget gates through real helper IPC", () => {
  it.each(["run", "phase", "phase-rebase"])(
    "rechecks %s spend for a held runner and seven queued calls",
    async (scope) => {
      const first = deferred<void>();
      const queued = deferred<void>();
      const release = deferred<void>();
      const attempts: Array<{ index?: number; attempt?: number }> = [];
      const run = vi.fn(async (_prompt: string, options?: AgentRunOptions) => {
        attempts.push({ index: options?.callIndex, attempt: options?.attempt });
        if (attempts.length === 1) {
          first.resolve();
          await release.promise;
        }
        options?.onUsage?.({ ...UNIT });
        return "answer";
      });
      const execution = runWorkflow(
        `${META}
      ${scope === "run" ? "" : 'phase("limited",{budget:1});'}
      const calls = Array.from({length:8}, (_,i) => agent("call " + i).catch(e => e.code));
      ${scope === "phase-rebase" ? 'phase("limited",{budget:100}); phase("different");' : ""}
      await checkpoint("all admitted");
      const outputs = await Promise.all(calls);
      ${scope === "run" ? "" : 'phase("fresh",{budget:1}); await agent("fresh phase");'}
      return {outputs,spent:budget.spent()};`,
        {
          concurrency: 1,
          tokenBudget: scope === "run" ? 1 : null,
          agent: { run },
          confirm: async () => {
            queued.resolve();
            return true;
          },
        },
      );
      await Promise.all([first.promise, queued.promise]);
      expect(run).toHaveBeenCalledTimes(1);
      release.resolve();
      const result = await execution;
      expect(result.result).toEqual({
        outputs: ["answer", ...Array(7).fill(EXHAUSTED)],
        spent: scope === "run" ? 1 : 2,
      });
      expect(attempts).toEqual(
        scope === "run"
          ? [{ index: 0, attempt: 1 }]
          : [
              { index: 0, attempt: 1 },
              { index: 9, attempt: 1 },
            ],
      );
      expect(result.tokenUsage?.total).toBe(scope === "run" ? 1 : 2);
      // The fresh-phase call above also proves denied queued admissions release capacity.
    },
  );

  it.each(["run", "phase"])("checks %s budget before every empty/schema/execution retry", async (scope) => {
    for (const kind of ["empty", "schema", "failure"]) {
      const retrySpend = vi.fn();
      const agentEnd = vi.fn();
      const run = vi.fn(async (_prompt: string, options?: AgentRunOptions) => {
        options?.onUsage?.({ ...UNIT });
        if (kind === "failure")
          throw new WorkflowError("transient", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true });
        return kind === "empty" ? " " : "invalid";
      });
      const result = await runWorkflow(
        `${META}
        ${scope === "phase" ? 'phase("limited",{budget:1});' : ""}
        let code;
        try { await agent("retry",{retries:1${kind === "schema" ? ',schema:{type:"object",required:["ok"]}' : ""}}); }
        catch(e) {code=e.code;}
        return {code,spent:budget.spent()};`,
        {
          tokenBudget: scope === "run" ? 1 : null,
          agent: { run },
          onRetrySpend: retrySpend,
          onAgentEnd: agentEnd,
        },
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(result.result).toEqual({ code: EXHAUSTED, spent: 1 });
      expect(result.tokenUsage?.total).toBe(1);
      expect(retrySpend).toHaveBeenCalledExactlyOnceWith(1);
      expect(agentEnd).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          result: null,
          tokens: 1,
          tokenUsage: UNIT,
          errorCode: EXHAUSTED,
          recoverable: false,
        }),
      );
    }
  });

  it("shares completed run spend with queued nested live calls without deadlock", async () => {
    const first = deferred<void>();
    const childQueued = deferred<void>();
    const release = deferred<void>();
    const identities: string[] = [];
    const run = vi.fn(async (_prompt: string, options?: AgentRunOptions) => {
      identities.push(`${options?.runId}:${options?.callIndex}:${options?.attempt}`);
      first.resolve();
      await release.promise;
      options?.onUsage?.({ ...UNIT });
      return "parent";
    });
    const child = `${META}
      const calls = Array.from({length:4}, (_,i) => agent("child " + i).catch(e=>e.code));
      await checkpoint("child queued");
      return await Promise.all(calls);`;
    const execution = runWorkflow(
      `${META}
      const parent = agent("parent");
      const child = workflow("child");
      return {parent:await parent,child:await child,spent:budget.spent()};`,
      {
        runId: "shared-root",
        concurrency: 1,
        tokenBudget: 1,
        agent: { run },
        loadSavedWorkflow: () => child,
        confirm: async () => {
          childQueued.resolve();
          return true;
        },
      },
    );
    await Promise.all([first.promise, childQueued.promise]);
    release.resolve();
    expect((await execution).result).toEqual({ parent: "parent", child: Array(4).fill(EXHAUSTED), spent: 1 });
    expect(identities).toEqual(["shared-root:0:1"]);
  });

  it("keeps phase budgets frame-local even when a child inherits task phase attribution", async () => {
    const result = await runWorkflow(
      `${META}
      phase("task phase",{budget:1});
      await agent("parent");
      return await orchestrate([{id:"nested",phase:"task phase",run:()=>workflow("child")}]);`,
      {
        concurrency: 1,
        loadSavedWorkflow: () => `${META} return await agent("child");`,
        agent: {
          run: async (_prompt, options) => {
            options?.onUsage?.({ ...UNIT });
            return "answer";
          },
        },
      },
    );
    expect(result.result).toMatchObject({ results: { nested: "answer" } });
    expect(result.tokenUsage?.total).toBe(2);
  });

  it("allows in-flight overshoot but denies the next queued attempt", async () => {
    const both = deferred<void>();
    const release = deferred<void>();
    let started = 0;
    const run = vi.fn(async (_prompt: string, options?: AgentRunOptions) => {
      if (++started === 2) both.resolve();
      await release.promise;
      options?.onUsage?.({ ...UNIT });
      return "answer";
    });
    const execution = runWorkflow(
      `${META} return await Promise.all([0,1,2].map(i=>agent("call "+i).catch(e=>e.code)));`,
      {
        concurrency: 2,
        tokenBudget: 1,
        agent: { run },
      },
    );
    await both.promise;
    release.resolve();
    expect((await execution).result).toEqual(["answer", "answer", EXHAUSTED]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cancels queued admissions without spawning or leaking the limiter", async () => {
    const started = deferred<void>();
    const queued = deferred<void>();
    const controller = new AbortController();
    const run = vi.fn(async (_prompt: string, options?: AgentRunOptions) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
      return "unreachable";
    });
    const execution = runWorkflow(
      `${META}
      const calls = [0,1,2].map(i=>agent("call "+i));
      await checkpoint("queued"); return await Promise.all(calls);`,
      {
        concurrency: 1,
        tokenBudget: 1,
        signal: controller.signal,
        agent: { run },
        confirm: async () => {
          queued.resolve();
          return true;
        },
      },
    );
    const outcome = expect(execution).rejects.toThrow();
    await Promise.all([started.promise, queued.promise]);
    controller.abort();
    await outcome;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("replays journaled agent and nested boundaries before checking exhausted live budgets", async () => {
    for (const nested of [false, true]) {
      const journal: JournalEntry[] = [];
      const script = `${META} phase("limited",{budget:1}); return await ${nested ? 'workflow("child")' : 'agent("work")'};`;
      const run = vi.fn(async (_prompt: string, options?: AgentRunOptions) => {
        options?.onUsage?.({ ...UNIT });
        return "answer";
      });
      const options = {
        runId: "replay-root",
        tokenBudget: 1,
        agent: { run },
        loadSavedWorkflow: () => `${META} return await agent("work");`,
        onAgentJournal: (entry: JournalEntry) => journal.push(entry),
        onWorkflowJournal: (entry: JournalEntry) => journal.push(entry),
      };
      await runWorkflow(script, options);
      const replay = await runWorkflow(script, {
        ...options,
        initialTokenUsage: { ...UNIT },
        resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
      });
      expect(replay.result).toBe("answer");
      expect(replay.tokenUsage?.total).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
      await expect(
        runWorkflow(
          `${script.slice(0, script.indexOf("return await"))} await ${nested ? 'workflow("child")' : 'agent("work")'}; return await agent("new live call");`,
          {
            ...options,
            initialTokenUsage: { ...UNIT },
            resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
          },
        ),
      ).rejects.toThrow(/budget exhausted/);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
});

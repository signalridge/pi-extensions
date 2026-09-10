import { describe, expect, it } from "vitest";
import { type JournalEntry, runWorkflow } from "../src/runtime.js";

describe("deferred live dispatch", () => {
  it("captures lexical phases and call hashes before yielding, including replay", async () => {
    const script = `export const meta = { name: "lexical", description: "test" };
      phase("first"); const a = agent("one");
      phase("second"); const b = agent("two");
      phase("after"); return [await a, await b];`;
    const starts: Array<{ id: string; phase?: string }> = [];
    const journal = new Map<string, JournalEntry>();
    let returned = false;
    const pending = runWorkflow(script, {
      runId: "lexical",
      onAgentStart: (entry) => starts.push(entry),
      onAgentJournal: (entry) => journal.set(`lexical:${entry.index}`, entry),
      agent: {
        run: async (prompt) => {
          expect(returned).toBe(true);
          return prompt;
        },
      },
    });
    returned = true;
    expect((await pending).result).toEqual(["one", "two"]);
    expect(starts.map(({ id, phase }) => ({ id, phase }))).toEqual([
      { id: "lexical:0", phase: "first" },
      { id: "lexical:1", phase: "second" },
    ]);
    expect(journal.size).toBe(2);
    const replay = await runWorkflow(script, {
      runId: "lexical",
      resumeJournal: journal,
      agent: {
        run: () => {
          throw new Error("must replay");
        },
      },
    });
    expect(replay.result).toEqual(["one", "two"]);
  });

  it("releases thread ownership and limiter slots after a synchronous runner throw", async () => {
    let calls = 0;
    const result = await runWorkflow(
      `export const meta = { name: "throw", description: "test" };
      const a = await agent("one", { thread: "worker" });
      const b = await agent("two", { thread: "worker" }); return [a, b];`,
      {
        concurrency: 1,
        agent: {
          run: () => {
            if (++calls === 1) throw new Error("synchronous dispatch failure");
            return Promise.resolve("ok");
          },
        },
      },
    );
    expect(result.result).toEqual([null, "ok"]);
    expect(calls).toBe(2);
  });

  it("checks an abort after yielding before any live-start observer or runner", async () => {
    const controller = new AbortController();
    let starts = 0;
    const pending = runWorkflow(
      `export const meta = { name: "abort", description: "test" };
      return await agent("never-start", { thread: "worker" });`,
      {
        signal: controller.signal,
        onAgentStart: () => {
          starts++;
        },
        agent: {
          run: () => {
            starts++;
            return Promise.resolve("unexpected");
          },
        },
      },
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(starts).toBe(0);
  });
});

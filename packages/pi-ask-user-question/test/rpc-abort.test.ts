import assert from "node:assert/strict";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { askUserQuestionTool } from "../src/ask-user-question.js";

for (const kind of ["single", "multi", "other"] as const) {
  test(`RPC ${kind} abort closes the native prompt span before another question`, async () => {
    const runner = new ExtensionRunner([], {} as never, process.cwd(), {} as never, {} as never);
    const events: string[] = [];
    vi.spyOn(runner, "emit").mockImplementation(async (event) => {
      events.push(event.type);
      return undefined;
    });
    let complete: (answer: string | undefined) => void = () => {};
    let opened: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const pending = (_title: string, _options: unknown, opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((resolve) => {
        complete = resolve;
        opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        opened();
      });
    runner.setUIContext(
      {
        select: kind === "other" ? async () => "Other (free text)" : pending,
        input: pending,
        editor: () => {
          throw new Error("RPC editor cannot be aborted");
        },
      } as never,
      "rpc",
    );
    const params = {
      questions: [{ question: "Pick?", multiSelect: kind === "multi", options: [{ label: "A" }, { label: "B" }] }],
    };
    const controller = new AbortController();
    const result = askUserQuestionTool.execute(
      "first",
      params as never,
      controller.signal,
      undefined,
      runner.createContext(),
    );
    await ready;
    const staleComplete = complete;
    controller.abort();
    const cancelled = await result;
    assert.equal(cancelled.details.cancelled, true);
    assert.equal(cancelled.details.reason, "aborted");
    assert.deepEqual(cancelled.details.answers, []);
    runner.setUIContext({ select: pending } as never, "rpc");
    const next = askUserQuestionTool.execute(
      "next",
      { questions: [{ question: "Next?", options: [{ label: "A" }, { label: "B" }] }] } as never,
      undefined,
      undefined,
      runner.createContext(),
    );
    staleComplete("B");
    complete("A");
    const answer = await next;
    assert.equal(answer.details.cancelled, false);
    assert.deepEqual(answer.details.answers[0]?.selected, { label: "A", value: "A", index: 0 });
    await Promise.resolve();
    const pairs = kind === "other" ? 3 : 2;
    assert.deepEqual(events, Array.from({ length: pairs }, () => ["ui_prompt_start", "ui_prompt_end"]).flat());
  });
}

/**
 * question-paging.test.ts — `askPlanModeQuestions` as a navigable sequence.
 *
 * The questions arrive as a batch and are answered one screen at a time. What
 * the earlier one-way loop lacked was the navigation: no sense of how many
 * remained, and no way back, so a misread option could only be fixed by
 * cancelling the whole batch and making the model ask again.
 *
 * The property that keeps that correct is that answers are held by POSITION.
 * Appending would leave a stale answer sitting behind its correction.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { askPlanModeQuestions } from "../src/question-tool.js";

const question = (id: string, labels: string[]) => ({
  id,
  header: `H-${id}`,
  question: `Q-${id}?`,
  options: labels.map((label) => ({ label })),
});

/**
 * Drive the prompt with a script of answers.
 *
 * Each entry either picks by 1-based option number, asks for the Back choice,
 * cancels, or supplies free-form text. Every prompt's title and options are
 * recorded so a test can assert on what the user was actually shown.
 */
function driver(script: Array<{ pick?: number; back?: true; cancel?: true; custom?: string | undefined }>) {
  const shown: { title: string; options: string[] }[] = [];
  let step = 0;
  let pendingCustom: string | undefined;

  const ctx = {
    ui: {
      select: async (title: string, options: string[]) => {
        shown.push({ title, options });
        const action = script[step++];
        if (!action || action.cancel) return undefined;
        if (action.back) return options.find((o) => o.startsWith("← Back"));
        if (action.custom !== undefined || "custom" in action) {
          pendingCustom = action.custom;
          // The free-form entry is always the option after the real ones.
          return options.find((o) => o.endsWith("Other (free-form)"));
        }
        return options[(action.pick ?? 1) - 1];
      },
      editor: async () => pendingCustom,
    },
  } as never;

  return { ctx, shown };
}

describe("a single question", () => {
  test("is asked without paging chrome", async () => {
    const { ctx, shown } = driver([{ pick: 1 }]);
    await askPlanModeQuestions([question("a", ["one", "two"])], ctx);
    assert.equal(shown[0]?.title.startsWith("["), false);
    assert.equal(
      shown[0]?.options.some((o) => o.startsWith("← Back")),
      false,
    );
  });

  test("returns the chosen option with its 1-based index", async () => {
    const { ctx } = driver([{ pick: 2 }]);
    const answers = await askPlanModeQuestions([question("a", ["one", "two"])], ctx);
    assert.deepEqual(answers, [
      { id: "a", header: "H-a", question: "Q-a?", answer: "two", wasCustom: false, optionIndex: 2 },
    ]);
  });
});

describe("a batch", () => {
  const batch = [question("a", ["a1", "a2"]), question("b", ["b1", "b2"]), question("c", ["c1"])];

  test("shows the position, so the sequence has an end in sight", async () => {
    const { ctx, shown } = driver([{ pick: 1 }, { pick: 1 }, { pick: 1 }]);
    await askPlanModeQuestions(batch, ctx);
    assert.ok(shown[0]?.title.startsWith("[1/3] "));
    assert.ok(shown[1]?.title.startsWith("[2/3] "));
    assert.ok(shown[2]?.title.startsWith("[3/3] "));
  });

  test("answers in order", async () => {
    const { ctx } = driver([{ pick: 1 }, { pick: 2 }, { pick: 1 }]);
    const answers = await askPlanModeQuestions(batch, ctx);
    assert.deepEqual(
      answers?.map((a) => a.answer),
      ["a1", "b2", "c1"],
    );
  });

  test("offers no Back on the first question, and does on the rest", async () => {
    const { ctx, shown } = driver([{ pick: 1 }, { pick: 1 }, { pick: 1 }]);
    await askPlanModeQuestions(batch, ctx);
    assert.equal(
      shown[0]?.options.some((o) => o.startsWith("← Back")),
      false,
    );
    assert.equal(
      shown[1]?.options.some((o) => o.startsWith("← Back")),
      true,
    );
  });
});

describe("going back", () => {
  const batch = [question("a", ["a1", "a2"]), question("b", ["b1", "b2"])];

  test("returns to the previous question", async () => {
    const { ctx, shown } = driver([{ pick: 1 }, { back: true }, { pick: 2 }, { pick: 1 }]);
    await askPlanModeQuestions(batch, ctx);
    assert.ok(shown[2]?.title.startsWith("[1/2] "));
  });

  // The whole point: the corrected answer replaces the original rather than
  // being appended behind it.
  test("overwrites the revised answer instead of keeping both", async () => {
    const { ctx } = driver([{ pick: 1 }, { back: true }, { pick: 2 }, { pick: 1 }]);
    const answers = await askPlanModeQuestions(batch, ctx);
    assert.equal(answers?.length, 2);
    assert.deepEqual(
      answers?.map((a) => a.answer),
      ["a2", "b1"],
    );
  });

  test("can step back more than once", async () => {
    const three = [...batch, question("c", ["c1"])];
    const { ctx } = driver([
      { pick: 1 },
      { pick: 1 },
      { back: true },
      { back: true },
      { pick: 2 },
      { pick: 2 },
      { pick: 1 },
    ]);
    const answers = await askPlanModeQuestions(three, ctx);
    assert.deepEqual(
      answers?.map((a) => a.answer),
      ["a2", "b2", "c1"],
    );
  });

  test("cancelling after stepping back still cancels the batch", async () => {
    const { ctx } = driver([{ pick: 1 }, { back: true }, { cancel: true }]);
    assert.equal(await askPlanModeQuestions(batch, ctx), undefined);
  });
});

describe("free-form answers", () => {
  const one = [question("a", ["a1"])];

  test("are recorded as custom", async () => {
    const { ctx } = driver([{ custom: "my own answer" }]);
    const answers = await askPlanModeQuestions(one, ctx);
    assert.deepEqual(answers, [{ id: "a", header: "H-a", question: "Q-a?", answer: "my own answer", wasCustom: true }]);
  });

  // Opening the editor and thinking better of it is a correction, not a
  // decision to throw away everything already answered.
  test("an empty one re-asks the question instead of cancelling the batch", async () => {
    const { ctx, shown } = driver([{ custom: undefined }, { pick: 1 }]);
    const answers = await askPlanModeQuestions(one, ctx);
    assert.deepEqual(
      answers?.map((a) => a.answer),
      ["a1"],
    );
    assert.equal(shown.length, 2);
  });
});

describe("cancellation", () => {
  test("dismissing the picker cancels the whole batch", async () => {
    const { ctx } = driver([{ cancel: true }]);
    assert.equal(await askPlanModeQuestions([question("a", ["a1"])], ctx), undefined);
  });

  test("dismissing a later question discards the earlier answers too", async () => {
    const { ctx } = driver([{ pick: 1 }, { cancel: true }]);
    const answers = await askPlanModeQuestions([question("a", ["a1"]), question("b", ["b1"])], ctx);
    assert.equal(answers, undefined);
  });

  // Plan mode can end while a prompt is open, and an answer collected after
  // that must not be delivered as if the mode were still active.
  test("stops when plan mode ends mid-batch", async () => {
    const { ctx } = driver([{ pick: 1 }, { pick: 1 }]);
    let alive = true;
    const answers = await askPlanModeQuestions([question("a", ["a1"]), question("b", ["b1"])], ctx, () => {
      const current = alive;
      alive = false;
      return current;
    });
    assert.equal(answers, undefined);
  });
});

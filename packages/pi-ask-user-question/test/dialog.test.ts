import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { type DialogOutcome, QuestionDialog } from "../src/dialog.js";
import { normalizeQuestions } from "../src/normalize.js";
import { fakeTheme, fakeTui, keybindings, makeQuestions } from "./support.js";

test("dialog renders a visible border, sanitizes text, and fits narrow widths", () => {
  const normalized = normalizeQuestions({
    questions: [
      {
        question: "Unsafe\u001b]2;title\u0007 question\nwith a long line",
        options: [{ label: "One\u001b[31m" }, { label: "Two" }],
      },
    ],
  });
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  const dialog = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    normalized.questions,
    () => undefined,
  );
  const lines = dialog.render(30);
  assert.ok(lines.length >= 4);
  assert.ok(stripVTControlCharacters(lines[0] ?? "").includes("─"));
  assert.ok(stripVTControlCharacters(lines.at(-1) ?? "").includes("─"));
  assert.ok(lines.every((line) => stripVTControlCharacters(line).length <= 30));
  assert.doesNotMatch(lines.join("\n"), /title/);
  assert.equal(lines.join("\n").includes(String.fromCharCode(27)), false);
});

test("single selection, Other editor, multi-select, Back, Escape, and dispose are idempotent", () => {
  const first = makeQuestions();
  let outcome: DialogOutcome | undefined;
  const dialog = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    first,
    (value) => (outcome = value),
  );
  dialog.focused = true;
  dialog.handleInput("\r");
  assert.equal(outcome?.kind, "answered");

  let customOutcome: DialogOutcome | undefined;
  const custom = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    first,
    (value) => (customOutcome = value),
  );
  custom.focused = true;
  custom.handleInput("\u001b[B");
  custom.handleInput("\u001b[B");
  custom.handleInput("\r");
  custom.handleInput("custom response");
  custom.handleInput("\r");
  assert.equal(customOutcome?.kind, "answered");
  if (customOutcome?.kind === "answered") assert.equal(customOutcome.answers[0]?.freeText, "custom response");

  let editorCancelled: DialogOutcome | undefined;
  const editorCancel = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    first,
    (value) => (editorCancelled = value),
  );
  editorCancel.handleInput("\u001b[B");
  editorCancel.handleInput("\u001b[B");
  editorCancel.handleInput("\r");
  editorCancel.handleInput("\u001b");
  assert.equal(editorCancelled, undefined);
  editorCancel.handleInput("\u001b");
  assert.equal(editorCancelled?.kind, "cancelled");

  let multiOutcome: DialogOutcome | undefined;
  const multi = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    makeQuestions({ multiSelect: true }),
    (value) => (multiOutcome = value),
  );
  multi.focused = true;
  multi.handleInput(" ");
  multi.handleInput("\u001b[B");
  multi.handleInput(" ");
  multi.handleInput("\u001b[B");
  multi.handleInput("\u001b[B");
  multi.handleInput("\r");
  assert.equal(multiOutcome?.kind, "answered");
  if (multiOutcome?.kind === "answered") assert.equal(Array.isArray(multiOutcome.answers[0]?.selected), true);

  let multiOtherOutcome: DialogOutcome | undefined;
  const multiOther = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    makeQuestions({ multiSelect: true }),
    (value) => (multiOtherOutcome = value),
  );
  multiOther.handleInput("\u001b[B");
  multiOther.handleInput("\u001b[B");
  multiOther.handleInput("\r");
  multiOther.handleInput("free-form choice");
  multiOther.handleInput("\r");
  multiOther.handleInput("\u001b[B");
  multiOther.handleInput("\u001b[B");
  multiOther.handleInput("\r");
  assert.equal(multiOtherOutcome?.kind, "answered");
  if (multiOtherOutcome?.kind === "answered") {
    assert.equal(multiOtherOutcome.answers[0]?.freeText, "free-form choice");
  }

  let batchOutcome: DialogOutcome | undefined;
  const batch = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    [...makeQuestions(), ...makeQuestions({ id: "second", header: "Second" })],
    (value) => (batchOutcome = value),
  );
  batch.handleInput("\r");
  batch.handleInput("\u001b[B");
  batch.handleInput("\r");
  assert.equal(batchOutcome?.kind, "answered");

  let revisedOutcome: DialogOutcome | undefined;
  const revisable = new QuestionDialog(
    fakeTui(),
    fakeTheme(),
    keybindings() as never,
    [...makeQuestions(), ...makeQuestions({ id: "revised", header: "Revised" })],
    (value) => (revisedOutcome = value),
  );
  revisable.handleInput("\r");
  revisable.handleInput("\u001b[B");
  revisable.handleInput("\u001b[B");
  revisable.handleInput("\u001b[B");
  revisable.handleInput("\r");
  revisable.handleInput("\u001b[B");
  revisable.handleInput("\r");
  revisable.handleInput("\r");
  assert.equal(revisedOutcome?.kind, "answered");

  let cancelled = 0;
  const disposable = new QuestionDialog(fakeTui(), fakeTheme(), keybindings() as never, first, () => (cancelled += 1));
  disposable.dispose();
  disposable.dispose();
  disposable.handleInput("\u001b");
  assert.equal(cancelled, 1);
});

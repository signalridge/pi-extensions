import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { empty, type Params, ParamsSchema, transition } from "../src/state.js";

function parameters(baseRevision: number | string): Params {
  return validateToolArguments(
    { name: "todo", description: "Exact revision probe", parameters: ParamsSchema },
    {
      type: "toolCall",
      id: "revision-probe",
      name: "todo",
      arguments: { action: "add", title: "probe", baseRevision },
    },
  );
}

for (const value of [0.9, "0.9", 1.9, "1.9", -0.9, "-0.9", Number.MAX_SAFE_INTEGER + 1]) {
  test(`native validation rejects lossy or unsafe revision ${JSON.stringify(value)}`, () => {
    const current = empty();
    assert.throws(() => parameters(value), /Validation failed/);
    assert.equal(current.revision, 0);
    assert.deepEqual(current.tasks, []);
  });
}

for (const value of [0, "0"]) {
  test(`native validation retains exact integer revision ${JSON.stringify(value)}`, () => {
    const args = parameters(value);
    assert.equal(args.baseRevision, 0);
    assert.equal(transition(empty(), args).revision, 1);
  });
}

test("a coerced stale integer remains stale and a current exact integer can mutate", () => {
  const first = transition(empty(), parameters("0"));
  assert.throws(() => transition(first, parameters("0")), /Stale baseRevision/);
  assert.equal(first.revision, 1);
  assert.equal(first.tasks.length, 1);
  const second = transition(first, parameters("1"));
  assert.equal(second.revision, 2);
  assert.equal(second.tasks.length, 2);
});

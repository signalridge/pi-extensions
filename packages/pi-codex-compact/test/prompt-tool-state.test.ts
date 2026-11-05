import assert from "node:assert/strict";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { test } from "vitest";
import { type SystemPromptViews, ToolStateTracker } from "../src/tool-state.js";

const tools: Tool[] = [{ name: "inspect", description: "Inspect synthetic data", parameters: Type.Object({}) }];
const prompts: SystemPromptViews = { canonical: "Canonical\r\nenvelope", effective: "Effective\r\nenvelope" };
const ordinary = () => ({
  tools: tools.map((tool) => ({ type: "function", ...tool })),
  instructions: prompts.effective,
});
const remote = () => ({ ...ordinary(), instructions: prompts.canonical });
function fixture() {
  const tracker = new ToolStateTracker();
  const owner = {};
  tracker.prepare(owner, "session", tools, tools, prompts);
  tracker.observe(owner, "session", tools, tools, ordinary(), prompts);
  return { tracker, owner };
}

test("fresh ordinary effective instructions witness both prompt views; remote uses canonical instructions", () => {
  const { tracker, owner } = fixture();
  assert.equal(tracker.matchesPrompt(owner, "session", prompts), true);
  assert.equal(tracker.matches(owner, "session", tools, tools), true);
  const validate = tracker.payloadValidator(owner, "session", prompts);
  assert.ok(validate);
  assert.equal(validate(remote()), true);
  assert.equal(validate(ordinary()), false);
  assert.equal(validate({ ...remote(), instructions: "Different canonical envelope" }), false);
  assert.equal(validate({ ...remote(), tools: [] }), false);
});

test("equal prompts retain cold/tool-only behavior and do not inherit a previous forced validator", () => {
  const { tracker, owner } = fixture();
  const equal = { canonical: "New base", effective: "New base" };
  assert.equal(tracker.matchesPrompt({}, "cold", equal), true);
  assert.equal(tracker.payloadValidator({}, "cold", equal), undefined);
  assert.equal(tracker.matches({}, "cold", tools, tools), true);
  const validate = tracker.payloadValidator(owner, "session", equal);
  assert.ok(validate);
  assert.equal(validate({ ...ordinary(), instructions: equal.canonical }), true);
  assert.equal(validate({ ...ordinary(), tools: [] }), false, "tool evidence is still exact");
});

for (const drift of ["canonical", "effective"] as const) {
  test(`${drift}-only drift fails both live matching and cached callback admission`, () => {
    const { tracker, owner } = fixture();
    const changed = { ...prompts, [drift]: "Changed view" };
    assert.equal(tracker.matchesPrompt(owner, "session", changed), false);
    tracker.observe(owner, "session", tools, tools, { ...ordinary(), instructions: changed.effective }, changed);
    assert.equal(tracker.matchesPrompt(owner, "session", changed), false);
    assert.equal(tracker.matchesPrompt(owner, "session", prompts), false, "old accepted proof was retired");
    assert.equal(tracker.payloadValidator(owner, "session", changed)?.(remote()), false);
    tracker.prepare(owner, "session", tools, tools, changed);
    tracker.observe(owner, "session", tools, tools, { ...ordinary(), instructions: changed.effective }, changed);
    assert.equal(tracker.matchesPrompt(owner, "session", changed), true);
  });
}

test("neither a cold forced callback nor a tool-only/equal preparation proves a newly forced prompt", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  for (const prepared of [undefined, { canonical: prompts.canonical, effective: prompts.canonical }]) {
    tracker.prepare(owner, "session", tools, tools, prepared);
    tracker.observe(owner, "session", tools, tools, ordinary(), prompts);
    assert.equal(tracker.matchesPrompt(owner, "session", prompts), false);
    assert.equal(tracker.payloadValidator(owner, "session", prompts)?.(remote()), false);
  }
  tracker.reset(owner);
  tracker.observe(owner, "session", tools, tools, ordinary(), prompts);
  assert.equal(tracker.matchesPrompt(owner, "session", prompts), false);
});

test("new preparation retires accepted proof until observation; unsent registry edits stay rejected", () => {
  const { tracker, owner } = fixture();
  tracker.prepare(owner, "session", tools, tools, prompts);
  assert.equal(tracker.matchesPrompt(owner, "session", prompts), false);
  tracker.observe(owner, "session", tools, [{ ...tools[0], description: "Unsent edit" }], ordinary(), prompts);
  assert.equal(tracker.matchesPrompt(owner, "session", prompts), false);
  assert.equal(tracker.matches(owner, "session", tools, tools), false);
});

for (const preparedPrompts of [undefined, { canonical: "Base", effective: "Base" }]) {
  test(`accepted wire knowledge survives pending ${preparedPrompts ? "equal-prompt" : "tool-only"} preparation`, () => {
    const tracker = new ToolStateTracker();
    const owner = {};
    const extra = { name: "extra", description: "Extra", parameters: Type.Object({}) };
    const recorded = [...tools, extra];
    const wire = {
      tools: [{ type: "function", ...tools[0], strict: true, parameters: Type.Object({ normalized: Type.Null() }) }],
      input: [{ type: "additional_tools", role: "developer", tools: [{ type: "function", ...extra }] }],
    };
    tracker.prepare(owner, "session", recorded, recorded, preparedPrompts);
    tracker.observe(owner, "session", recorded, recorded, wire, preparedPrompts);
    tracker.prepare(owner, "session", recorded, recorded, preparedPrompts);
    assert.equal(tracker.matches(owner, "session", recorded, recorded), true);
    const validate = tracker.payloadValidator(owner, "session", preparedPrompts);
    assert.ok(validate, "a pending prepare is not a cold request: keep the frozen wire validator");
    assert.equal(validate(wire), true);
    assert.equal(validate({ ...wire, tools: [{ ...wire.tools[0], strict: false }] }), false);
    assert.equal(validate({ ...wire, tools: [{ ...wire.tools[0], parameters: Type.Object({}) }] }), false);
    assert.equal(validate({ tools: [...wire.tools, ...wire.input[0].tools] }), false);
    const changed = [{ ...tools[0], description: "Unsent registry edit" }];
    tracker.prepare(owner, "session", changed, changed, preparedPrompts);
    assert.equal(tracker.matches(owner, "session", changed, changed), false, "do not retarget old wire evidence");
  });
}

for (const rejected of ["hidden wire", "early mismatch"] as const) {
  test(`${rejected} remains negative evidence through prepare without another callback`, () => {
    const { tracker, owner } = fixture();
    const equal = { canonical: "Base", effective: "Base" };
    tracker.prepare(owner, "session", tools, tools, equal);
    tracker.observe(owner, "session", tools, tools, { tools: [] }, rejected === "early mismatch" ? prompts : equal);
    assert.equal(tracker.matches(owner, "session", tools, tools), false);
    tracker.prepare(owner, "session", tools, tools, equal);
    assert.equal(
      tracker.matches(owner, "session", tools, tools),
      false,
      "negative evidence must not become cold equality",
    );
  });
}

for (const accepted of [true, false]) {
  test(`an early callback/session mismatch retires acceptance without making known tools cold (accepted=${accepted})`, () => {
    const { tracker, owner } = fixture();
    if (!accepted) tracker.observe(owner, "session", tools, tools, { tools: [] }, prompts);
    tracker.prepare(owner, "replacement", tools, tools, prompts);
    tracker.observe(owner, "session", tools, tools, ordinary(), prompts);
    assert.equal(tracker.matches(owner, "session", tools, tools), false);
    assert.equal(tracker.matchesPrompt(owner, "session", prompts), false);
  });
}

test("pending preparation invalidates divergent prompt authorization but retains the old exact tool wire", () => {
  const { tracker, owner } = fixture();
  const changed = { canonical: "Fresh canonical", effective: "Fresh effective" };
  tracker.prepare(owner, "session", tools, tools, changed);
  assert.equal(tracker.matchesPrompt(owner, "session", prompts), false);
  assert.equal(tracker.matchesPrompt(owner, "session", changed), false);
  assert.equal(tracker.payloadValidator(owner, "session", prompts)?.(remote()), false);
  assert.equal(tracker.matches(owner, "session", tools, tools), true);
  tracker.observe(owner, "session", tools, tools, { ...ordinary(), instructions: changed.effective }, changed);
  assert.equal(tracker.matchesPrompt(owner, "session", changed), true);
  assert.equal(tracker.matchesPrompt(owner, "session", prompts), false);
});

for (const reset of ["owner", "session", "reload", "tree"] as const) {
  test(`divergent prompt evidence is fenced by ${reset}`, () => {
    const { tracker, owner } = fixture();
    if (reset === "reload" || reset === "tree") tracker.reset(owner);
    const currentOwner = reset === "owner" ? {} : owner;
    const session = reset === "session" ? "replacement" : "session";
    assert.equal(tracker.matchesPrompt(currentOwner, session, prompts), false);
    assert.equal(tracker.payloadValidator(currentOwner, session, prompts)?.(remote()), false);
    tracker.observe(currentOwner, session, tools, tools, ordinary(), prompts);
    assert.equal(tracker.matchesPrompt(currentOwner, session, prompts), false);
  });
}

for (const shape of [
  "missing",
  "mutation",
  "nonstring",
  "getter",
  "hidden",
  "inherited",
  "proxy",
  "toJSON",
  "toJSON getter",
] as const) {
  test(`instructions ${shape} rejects without executing hooks or retaining earlier accepted proof`, () => {
    const { tracker, owner } = fixture();
    const validate = tracker.payloadValidator(owner, "session", prompts);
    assert.ok(validate);
    let executions = 0;
    const hook = () => {
      executions++;
      throw new Error("Must not execute");
    };
    const malformed = (canonical: boolean): unknown => {
      const wire: Record<string, unknown> = canonical ? remote() : ordinary();
      switch (shape) {
        case "missing":
          delete wire.instructions;
          break;
        case "mutation":
          wire.instructions = "Not witnessed";
          break;
        case "nonstring":
          wire.instructions = { toString: hook };
          break;
        case "getter":
          Object.defineProperty(wire, "instructions", { get: hook });
          break;
        case "hidden":
          Object.defineProperty(wire, "instructions", { enumerable: false });
          break;
        case "inherited":
          delete wire.instructions;
          Object.setPrototypeOf(wire, { instructions: prompts.effective });
          break;
        case "proxy":
          return new Proxy(wire, { getOwnPropertyDescriptor: hook });
        case "toJSON":
          Object.defineProperty(wire, "toJSON", { value: hook });
          break;
        case "toJSON getter":
          Object.defineProperty(wire, "toJSON", { get: hook });
          break;
      }
      return wire;
    };
    assert.equal(validate(malformed(true)), false);
    tracker.observe(owner, "session", tools, tools, malformed(false), prompts);
    assert.equal(tracker.matchesPrompt(owner, "session", prompts), false);
    assert.equal(tracker.matches(owner, "session", tools, tools), false);
    assert.equal(tracker.payloadValidator(owner, "session", prompts)?.(remote()), false);
    assert.equal(executions, 0);
  });
}

for (const text of ["LF\ntext", "CRLF\r\ntext", " lone\rCR ", " Unicode λ😀 ", "\ud800"]) {
  test(`prompt instructions are exact, not whitespace/Unicode-normalized: ${JSON.stringify(text)}`, () => {
    const tracker = new ToolStateTracker();
    const owner = {};
    const views = { canonical: text, effective: `${text}\nForced` };
    tracker.prepare(owner, "session", tools, tools, views);
    tracker.observe(owner, "session", tools, tools, { ...ordinary(), instructions: views.effective }, views);
    const validate = tracker.payloadValidator(owner, "session", views);
    assert.ok(validate);
    assert.equal(validate({ ...remote(), instructions: text }), true);
    assert.equal(validate({ ...remote(), instructions: `${text} ` }), false);
    if (text.includes("\r\n"))
      assert.equal(validate({ ...remote(), instructions: text.replace(/\r\n/g, "\n") }), false);
    views.canonical = "Mutated caller object";
    assert.equal(
      validate({ ...remote(), instructions: text }),
      true,
      "validator freezes the operation's canonical string",
    );
  });
}

test("empty canonical divergence fails closed without guessing native fallback instructions", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const views = { canonical: "", effective: "Forced" };
  tracker.prepare(owner, "session", tools, tools, views);
  tracker.observe(owner, "session", tools, tools, { ...ordinary(), instructions: views.effective }, views);
  assert.equal(tracker.matchesPrompt(owner, "session", views), false);
  assert.equal(tracker.payloadValidator(owner, "session", views)?.({ ...remote(), instructions: "" }), false);
  assert.equal(tracker.matchesPrompt(owner, "session", { canonical: "", effective: "" }), true);
});

test("divergent witness does not bypass additive declaration, schema or hidden-tool guards", () => {
  const extra = { name: "extra", description: "Extra", parameters: Type.Object({}) };
  const recorded = [...tools, extra];
  const wire = {
    ...ordinary(),
    input: [{ type: "additional_tools", role: "developer", tools: [{ type: "function", ...extra }] }],
  };
  for (const negative of ["hidden", "redefined", "search", "schema", "metadata", "group order"] as const) {
    const tracker = new ToolStateTracker();
    const owner = {};
    tracker.prepare(owner, "session", recorded, recorded, prompts);
    tracker.observe(owner, "session", recorded, recorded, wire, prompts);
    const validate = tracker.payloadValidator(owner, "session", prompts);
    assert.ok(validate);
    assert.equal(validate({ ...wire, instructions: remote().instructions }), true);
    const changed = structuredClone(wire);
    const registry = structuredClone(recorded);
    switch (negative) {
      case "hidden":
        changed.tools = [];
        break;
      case "redefined":
        changed.input[0].tools[0].name = tools[0].name;
        break;
      case "search":
        changed.input[0].type = "tool_search_output";
        break;
      case "schema":
        registry[1].parameters = Type.Object({ changed: Type.String() });
        break;
      case "metadata":
        Object.assign(changed.input[0], { unknown: true });
        break;
      case "group order":
        changed.tools.push(...changed.input[0].tools);
        changed.input = [];
        break;
    }
    assert.equal(validate({ ...changed, instructions: remote().instructions }), negative === "schema");
    tracker.observe(owner, "session", recorded, registry, changed, prompts);
    assert.equal(
      tracker.matchesPrompt(owner, "session", prompts),
      negative === "group order",
      "regrouping may be an ordinary witness, but not equivalent remote proof",
    );
  }
});

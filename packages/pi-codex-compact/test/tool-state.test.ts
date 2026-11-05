import assert from "node:assert/strict";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { test } from "vitest";
import { comparableTools, ToolStateTracker } from "../src/tool-state.js";

function tools(description = "Read a file"): Tool[] {
  return [{ name: "read", description, parameters: Type.Object({ path: Type.String() }) }];
}

function payload(recorded: Tool[]) {
  return { tools: recorded.map((tool) => ({ type: "function", ...tool })) };
}

function dispatch(tracker: ToolStateTracker, owner: object, recorded: Tool[], registry: Tool[]) {
  tracker.prepare(owner, "session", recorded, registry);
  tracker.observe(owner, "session", recorded, registry, payload(recorded));
}

test("transformed descriptions require prepared request evidence, not blanket description omission", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const registry = tools();
  const recorded = tools("Read a file; callable through codemode");
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  tracker.observe(owner, "session", recorded, registry, payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  dispatch(tracker, owner, recorded, registry);
  assert.equal(tracker.matches(owner, "session", recorded, registry), true);
  assert.equal(tracker.matches(owner, "session", tools("A new effective description"), registry), false);
  assert.equal(tracker.matches(owner, "session", recorded, tools("A newly registered description")), false);
});

test("snapshots detect in-place schema and description mutations", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  const registry = tools();
  dispatch(tracker, owner, recorded, registry);
  registry[0].description = "Changed";
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  tracker.observe(owner, "session", recorded, registry, payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, registry), false, "cached callbacks cannot bless the edit");
  registry[0].description = "Read a file";
  registry[0].parameters = Type.Object({ changed: Type.Boolean() });
  tracker.observe(owner, "session", recorded, registry, payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
});

test("cached observations cannot replace preparation; a new prepared request can admit new descriptions", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  dispatch(tracker, owner, recorded, tools());
  const changed = tools("Changed registry description");
  tracker.observe(owner, "session", recorded, changed, payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, changed), false);
  const next = tools("Changed effective description");
  tracker.prepare(owner, "session", next, changed);
  tracker.observe(owner, "session", next, changed, payload(recorded));
  assert.equal(tracker.matches(owner, "session", next, changed), false, "stale payload cannot prove new preparation");
  tracker.observe(owner, "session", next, changed, payload(next));
  assert.equal(tracker.matches(owner, "session", next, changed), true);
});

test("membership and schema mismatches cannot establish request evidence", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  dispatch(tracker, owner, recorded, tools());
  dispatch(tracker, owner, recorded, []);
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
  dispatch(tracker, owner, recorded, [{ ...tools()[0], parameters: Type.Object({ other: Type.Number() }) }]);
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
});

for (const wire of [
  undefined,
  null,
  {},
  { tools: [] },
  { tools: null },
  { tools: [null] },
  payload(tools("Wrong")),
  {
    tools: [...payload(tools()).tools, ...payload(tools()).tools],
  },
]) {
  test(`invalid or hidden wire declarations fail closed: ${JSON.stringify(wire)}`, () => {
    const tracker = new ToolStateTracker();
    const owner = {};
    dispatch(tracker, owner, tools(), tools());
    tracker.observe(owner, "session", tools(), tools(), wire);
    assert.equal(tracker.matches(owner, "session", tools(), tools()), false, "must not fall back to raw equality");
  });
}

test("observations are fenced by owner, session identity, and lifecycle reset", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  dispatch(tracker, owner, recorded, tools());
  assert.equal(tracker.matches({}, "session", recorded, tools()), false);
  assert.equal(tracker.matches(owner, "replacement", recorded, tools()), false);
  tracker.reset(owner);
  tracker.observe(owner, "session", recorded, tools(), payload(recorded));
  assert.equal(tracker.matches(owner, "session", recorded, tools()), false);
  assert.equal(tracker.matches(owner, "session", tools(), tools()), true);
});

test("wire schema/sampling normalization is frozen and checked again at remote serialization", () => {
  const tracker = new ToolStateTracker();
  const owner = {};
  const recorded = tools("Effective description");
  const wire = payload(recorded);
  wire.tools[0].parameters = Type.Object({ path: Type.Union([Type.String(), Type.Null()]) });
  tracker.prepare(owner, "session", recorded, tools());
  tracker.observe(owner, "session", recorded, tools(), wire);
  const validate = tracker.payloadValidator(owner, "session");
  assert.ok(validate);
  assert.equal(validate(structuredClone(wire)), true);
  assert.equal(validate(payload(recorded)), false);
  assert.equal(validate({ tools: [] }), false);
  assert.equal(tracker.payloadValidator(owner, "replacement"), undefined);
  wire.tools[0].description = "Later mutation";
  assert.equal(validate(wire), false);
  dispatch(tracker, owner, tools("New dispatch"), tools());
  assert.equal(validate(payload(tools("New dispatch"))), false, "an in-flight validator retains its original snapshot");
});

function additiveFixture() {
  const recorded: Tool[] = [
    ...tools(),
    { name: "todo", description: "Update a checklist", parameters: Type.Object({ title: Type.String() }) },
    { name: "inspect", description: "Inspect a path", parameters: Type.Object({ path: Type.String() }) },
  ];
  const registry = structuredClone(recorded);
  const declaration = (tool: Tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
    strict: false,
    format: { type: "text" },
  });
  const wire = {
    tools: [declaration(recorded[0])],
    input: [
      { type: "message", role: "user", content: "Ordinary text is not declaration evidence" },
      ...recorded.slice(1).map((tool) => ({ type: "additional_tools", role: "developer", tools: [declaration(tool)] })),
    ],
  };
  const tracker = new ToolStateTracker();
  const owner = {};
  tracker.prepare(owner, "session", recorded, registry);
  return { tracker, owner, recorded, registry, wire };
}

function groupTools(wire: ReturnType<typeof additiveFixture>["wire"], index: number) {
  const declarations = wire.input[index].tools;
  assert.ok(declarations);
  return declarations;
}

test("native additive declarations prove the effective loadout without flattening the wire snapshot", () => {
  const { tracker, owner, recorded, registry, wire } = additiveFixture();
  tracker.observe(owner, "session", recorded, registry, wire);
  assert.equal(tracker.matches(owner, "session", recorded, registry), true);
  const validate = tracker.payloadValidator(owner, "session");
  assert.ok(validate);
  assert.equal(validate(structuredClone(wire)), true);
  const textChanged = structuredClone(wire);
  textChanged.input[0].content = "Different canonical text";
  assert.equal(validate(textChanged), true, "ordinary text is neither retained nor compared");
  wire.input[0].content = "Mutated ordinary request";
  assert.equal(validate(textChanged), true);
  groupTools(wire, 1)[0].description = "Mutated after observation";
  assert.equal(validate(wire), false, "additive declarations are deeply snapshotted");
  assert.equal(validate(textChanged), true, "later mutations do not alter frozen evidence");
});

test("flat declaration order and flat-to-additive representation changes remain guarded", () => {
  const { tracker, owner, recorded, registry, wire } = additiveFixture();
  const flat = { tools: [...wire.tools, ...groupTools(wire, 1), ...groupTools(wire, 2)] };
  tracker.observe(owner, "session", recorded, registry, flat);
  const validate = tracker.payloadValidator(owner, "session");
  assert.ok(validate);
  assert.equal(validate(flat), true);
  assert.equal(validate({ tools: [...flat.tools].reverse() }), false);
  assert.equal(validate(wire), false, "flat-to-group is different proof even with identical definitions");
});

test("ordinary message and checkpoint content is never inspected or retained as tool evidence", () => {
  const { tracker, owner, recorded, registry, wire } = additiveFixture();
  Object.defineProperty(wire.input[0], "content", {
    get() {
      throw new Error("Ordinary content must not be read or cloned");
    },
  });
  wire.input.push({ type: "compaction", role: "", content: "not declaration evidence" });
  tracker.observe(owner, "session", recorded, registry, wire);
  const validate = tracker.payloadValidator(owner, "session");
  assert.ok(validate);
  assert.equal(validate(wire), true);
  wire.input.pop();
  assert.equal(validate(wire), true, "checkpoint content is outside the declaration snapshot");
});

for (const mutation of [
  "body schema",
  "group schema",
  "body description",
  "group description",
  "body strict",
  "group strict",
  "body format",
  "group format",
  "body membership",
  "group membership",
  "group order",
  "flatten",
  "regroup",
] as const) {
  test(`additive validator rejects changed ${mutation}, even when effective declarations agree`, () => {
    const { tracker, owner, recorded, registry, wire } = additiveFixture();
    tracker.observe(owner, "session", recorded, registry, wire);
    const validate = tracker.payloadValidator(owner, "session");
    assert.ok(validate);
    const changed = structuredClone(wire);
    const bodyTool = changed.tools[0];
    const groupTool = groupTools(changed, 1)[0];
    switch (mutation) {
      case "body schema":
        bodyTool.parameters = Type.Object({ changed: Type.Boolean() });
        break;
      case "group schema":
        groupTool.parameters = Type.Object({ changed: Type.Boolean() });
        break;
      case "body description":
        bodyTool.description = "Changed";
        break;
      case "group description":
        groupTool.description = "Changed";
        break;
      case "body strict":
        bodyTool.strict = true;
        break;
      case "group strict":
        groupTool.strict = true;
        break;
      case "body format":
        bodyTool.format.type = "json";
        break;
      case "group format":
        groupTool.format.type = "json";
        break;
      case "body membership":
        changed.tools = [];
        break;
      case "group membership":
        changed.input.splice(1, 1);
        break;
      case "group order":
        [changed.input[1], changed.input[2]] = [changed.input[2], changed.input[1]];
        break;
      case "flatten":
        changed.tools.push(...changed.input.slice(1).flatMap((item) => item.tools ?? []));
        changed.input.splice(1);
        break;
      case "regroup":
        groupTools(changed, 1).push(...groupTools(changed, 2));
        changed.input.splice(2, 1);
        break;
    }
    assert.equal(validate(changed), false);
  });
}

for (const mutation of [
  "hidden",
  "missing",
  "duplicate body",
  "duplicate group",
  "redefinition",
  "wrong role",
  "empty group",
  "invalid group",
  "extra metadata",
  "tool search output",
  "tool search call",
  "unknown tools update",
  "description",
  "raw schema",
  "raw membership",
  "duplicate recorded",
] as const) {
  test(`additive eligibility rejects ${mutation} without raw-equality bypass`, () => {
    const { tracker, owner, recorded, registry, wire } = additiveFixture();
    // Start with accepted evidence so an invalid new observation must retire it.
    tracker.observe(owner, "session", recorded, registry, wire);
    switch (mutation) {
      case "hidden":
        wire.tools = [];
        break;
      case "missing":
        wire.input.splice(1, 1);
        break;
      case "duplicate body":
        wire.tools.push(groupTools(wire, 1)[0]);
        break;
      case "duplicate group":
        wire.input.push(structuredClone(wire.input[1]));
        break;
      case "redefinition":
        groupTools(wire, 1)[0] = { ...wire.tools[0], description: "Redefined" };
        break;
      case "wrong role":
        wire.input[1].role = "system";
        break;
      case "empty group":
        wire.input[1].tools = [];
        break;
      case "invalid group":
        Object.assign(wire.input[1], { tools: [null] });
        break;
      case "extra metadata":
        Object.assign(wire.input[1], { unrecognized: { secret: "not retained" } });
        break;
      case "tool search output":
        wire.input[1].type = "tool_search_output";
        break;
      case "tool search call":
        wire.input.push({ type: "tool_search_call", role: "developer", tools: [] });
        break;
      case "unknown tools update":
        wire.input[1].type = "unknown_update";
        break;
      case "description":
        groupTools(wire, 1)[0].description = "Not recorded";
        break;
      case "raw schema":
        registry[1].parameters = Type.Object({ different: Type.String() });
        break;
      case "raw membership":
        registry.pop();
        break;
      case "duplicate recorded":
        recorded[2] = structuredClone(recorded[1]);
        registry[2] = structuredClone(recorded[1]);
        break;
    }
    tracker.prepare(owner, "session", recorded, registry);
    tracker.observe(owner, "session", recorded, registry, wire);
    assert.equal(tracker.matches(owner, "session", recorded, registry), false);
    assert.equal(tracker.payloadValidator(owner, "session"), undefined);
  });
}

test("additive evidence retains fresh preparation, owner/session, and cached-warming guards", () => {
  const { tracker, owner, recorded, registry, wire } = additiveFixture();
  recorded[1].description = "Effective transformed todo";
  groupTools(wire, 1)[0].description = recorded[1].description;
  tracker.observe(owner, "session", recorded, registry, wire);
  assert.equal(tracker.matches(owner, "session", recorded, registry), false, "cached callback lacks fresh proof");
  tracker.prepare(owner, "session", recorded, registry);
  tracker.observe({}, "session", recorded, registry, wire);
  tracker.observe(owner, "other", recorded, registry, wire);
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  tracker.observe(owner, "session", recorded, registry, wire);
  assert.equal(tracker.matches(owner, "session", recorded, registry), true);
  registry[1].description = "Unsent registry edit";
  tracker.observe(owner, "session", recorded, registry, wire);
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
  tracker.reset(owner);
  tracker.observe(owner, "session", recorded, registry, wire);
  assert.equal(tracker.matches(owner, "session", recorded, registry), false);
});

for (const exotic of [
  () => ({
    get tools() {
      throw new Error("Getter must not escape");
    },
  }),
  () => ({
    tools: [],
    get input() {
      throw new Error("Input getter must not escape");
    },
  }),
  () => ({ tools: [{ ...payload(tools()).tools[0], parameters: () => "not cloneable" }] }),
  () => ({ tools: [{ ...payload(tools()).tools[0], parameters: new Map() }] }),
  () => ({ tools: new Proxy(payload(tools()).tools, {}) }),
  () =>
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("Exotic payload");
        },
      },
    ),
  () => ({
    tools: payload(tools()).tools,
    input: [
      {
        type: "additional_tools",
        get role() {
          throw new Error("Role getter");
        },
      },
    ],
  }),
  () => {
    const tool = payload(tools()).tools[0];
    Object.defineProperty(tool, "metadata", { get: () => "unfrozen", enumerable: true });
    return { tools: [tool] };
  },
  () => ({ tools: [{ ...payload(tools()).tools[0], [Symbol("metadata")]: "unfrozen" }] }),
  () => {
    const tool = payload(tools()).tools[0];
    Object.assign(tool, { cycle: tool });
    return { tools: [tool] };
  },
]) {
  test("exotic wire observation and validation fail closed without throwing", () => {
    const tracker = new ToolStateTracker();
    const owner = {};
    dispatch(tracker, owner, tools(), tools());
    const validate = tracker.payloadValidator(owner, "session");
    assert.ok(validate);
    assert.equal(validate(exotic()), false);
    assert.doesNotThrow(() => tracker.observe(owner, "session", tools(), tools(), exotic()));
    assert.equal(tracker.matches(owner, "session", tools(), tools()), false);
    assert.equal(tracker.payloadValidator(owner, "session"), undefined);
  });
}

for (const override of [
  "descriptor toJSON",
  "inherited array toJSON",
  "payload toJSON",
  "ordinary item toJSON",
  "input iterator",
  "input index getter",
  "input proxy",
] as const) {
  test(`serialization override fails observation and validation without executing hooks: ${override}`, () => {
    const tracker = new ToolStateTracker();
    const owner = {};
    dispatch(tracker, owner, tools(), tools());
    const validate = tracker.payloadValidator(owner, "session");
    assert.ok(validate);
    const wire = { ...payload(tools()), input: [] as object[] };
    const hidden = { ...wire.tools[0], name: "hidden" };
    let executions = 0;
    const toJSON = () => {
      executions++;
      return hidden;
    };
    switch (override) {
      case "descriptor toJSON":
        Object.defineProperty(wire.tools[0], "toJSON", { value: toJSON });
        break;
      case "inherited array toJSON": {
        class CustomTools extends Array<(typeof wire.tools)[number]> {
          toJSON() {
            executions++;
            return [];
          }
        }
        wire.tools = new CustomTools(...wire.tools);
        break;
      }
      case "payload toJSON":
        Object.defineProperty(wire, "toJSON", {
          value: () => {
            executions++;
            return { tools: [hidden], input: [] };
          },
        });
        break;
      case "ordinary item toJSON": {
        const item = { type: "message", role: "user", content: "Not declaration evidence" };
        Object.defineProperty(item, "toJSON", {
          value: () => {
            executions++;
            return { type: "additional_tools", role: "developer", tools: [hidden] };
          },
        });
        wire.input.push(item);
        break;
      }
      case "input iterator":
        wire.input.push({ type: "tool_search_output", tools: [hidden] });
        Object.defineProperty(wire.input, Symbol.iterator, {
          value: () => {
            executions++;
            return [][Symbol.iterator]();
          },
        });
        break;
      case "input index getter":
        Object.defineProperty(wire.input, "0", {
          enumerable: true,
          get() {
            executions++;
            return { type: "message", role: "user", content: "Not declaration evidence" };
          },
        });
        break;
      case "input proxy":
        wire.input = new Proxy(wire.input, {
          getOwnPropertyDescriptor() {
            executions++;
            throw new Error("Proxy trap must not execute");
          },
        });
        break;
    }
    assert.equal(validate(wire), false);
    assert.doesNotThrow(() => tracker.observe(owner, "session", tools(), tools(), wire));
    assert.equal(tracker.matches(owner, "session", tools(), tools()), false);
    assert.equal(tracker.payloadValidator(owner, "session"), undefined);
    assert.equal(executions, 0, "no toJSON, iterator, indexed getter or proxy trap may execute during admission");
  });
}

for (const target of ["body tools", "input", "group tools", "metadata array"] as const) {
  test(`exotic ${target} arrays fail closed without reading accessor indices`, () => {
    for (const shape of ["prototype", "iterator", "index getter", "hole", "extra property", "hidden index"] as const) {
      const { tracker, owner, recorded, registry, wire } = additiveFixture();
      const metadata = ["native"];
      Object.assign(wire.tools[0], { metadata });
      tracker.observe(owner, "session", recorded, registry, wire);
      const validate = tracker.payloadValidator(owner, "session");
      assert.ok(validate);
      assert.equal(validate(wire), true);
      const array =
        target === "body tools"
          ? wire.tools
          : target === "input"
            ? wire.input
            : target === "group tools"
              ? groupTools(wire, 1)
              : metadata;
      const first = array[0];
      let executions = 0;
      switch (shape) {
        case "prototype":
          Object.setPrototypeOf(array, Object.create(Array.prototype));
          break;
        case "iterator":
          Object.defineProperty(array, Symbol.iterator, {
            value: () => {
              executions++;
              return [][Symbol.iterator]();
            },
          });
          break;
        case "index getter":
          Object.defineProperty(array, "0", {
            enumerable: true,
            get() {
              executions++;
              return first;
            },
          });
          break;
        case "hole":
          delete array[0];
          break;
        case "extra property":
          Object.defineProperty(array, "annotation", { value: "not an ordinary array" });
          break;
        case "hidden index":
          Object.defineProperty(array, "0", { enumerable: false });
          break;
      }
      assert.equal(validate(wire), false, shape);
      assert.doesNotThrow(() => tracker.observe(owner, "session", recorded, registry, wire), shape);
      assert.equal(tracker.matches(owner, "session", recorded, registry), false, shape);
      assert.equal(tracker.payloadValidator(owner, "session"), undefined, shape);
      assert.equal(executions, 0, shape);
    }
  });
}

test("metadata serialization hooks fail closed without invoking even nonenumerable toJSON getters", () => {
  for (const target of ["body", "group", "nested"] as const) {
    for (const hook of ["function", "getter"] as const) {
      const { tracker, owner, recorded, registry, wire } = additiveFixture();
      const metadata = { retained: "ordinary JSON" };
      Object.assign(wire.tools[0], { metadata });
      tracker.observe(owner, "session", recorded, registry, wire);
      const validate = tracker.payloadValidator(owner, "session");
      assert.ok(validate);
      const object = target === "body" ? wire.tools[0] : target === "group" ? groupTools(wire, 1)[0] : metadata;
      let executions = 0;
      const callback = () => {
        executions++;
        return {};
      };
      Object.defineProperty(object, "toJSON", hook === "getter" ? { get: callback } : { value: callback });
      assert.equal(validate(wire), false);
      tracker.observe(owner, "session", recorded, registry, wire);
      assert.equal(tracker.matches(owner, "session", recorded, registry), false);
      assert.equal(executions, 0);
    }
  }
});

test("non-callable toJSON schema properties and nonenumerable data annotations remain valid frozen metadata", () => {
  const { tracker, owner, recorded, registry, wire } = additiveFixture();
  wire.tools[0].parameters = Type.Object({ toJSON: Type.String() });
  Object.defineProperty(wire.tools[0].parameters, "annotation", { value: () => "not on the JSON wire" });
  tracker.observe(owner, "session", recorded, registry, wire);
  const validate = tracker.payloadValidator(owner, "session");
  assert.ok(validate);
  assert.equal(tracker.matches(owner, "session", recorded, registry), true);
  assert.equal(validate(wire), true);
  wire.tools[0].parameters = Type.Object({ toJSON: Type.Number() });
  assert.equal(validate(wire), false, "non-callable schema properties are still compared exactly");
});

test("comparison uses equivalent JSON schemas and only public shared fields", () => {
  const tracker = new ToolStateTracker();
  const tool = { ...tools()[0], constrainedSampling: true };
  assert.equal(tracker.matches({}, "session", comparableTools([tool]), tools()), true);
});

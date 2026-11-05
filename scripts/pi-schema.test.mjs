// Expectations come from pi-schema 1.5 README Coercion/Values and dist/coerce.js,
// and pi-ai 1.5 dist/utils/validation.js. These are compatibility assertions,
// not a validator implementation or snapshots of whatever the host returns.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import { Type } from "typebox";
import { assertExactHost, assertPerimeter } from "./pi-schema-qualification.mjs";

assertExactHost();
assertPerimeter();
test("qualification perimeter rejects network and out-of-sandbox writes in an owned child", () => {
  const code = `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    assert.throws(() => fetch("https://example.invalid"), /forbids network/);
    assert.throws(() => require("node:net").connect(443, "example.invalid"), /forbids network/);
    assert.throws(() => require("node:https").get("https://example.invalid"), /forbids network/);
    const outside = require("node:path").join(process.env.PI_SMOKE_SANDBOX, "..", "forbidden-qualification-write");
    assert.throws(() => fs.writeFileSync(outside, "never written"), /forbids writing/);
    fs.symlinkSync(require("node:path").dirname(process.env.PI_SMOKE_SANDBOX), "outside-link");
    assert.throws(() => fs.writeFileSync("outside-link/forbidden-qualification-write", "never written"), /forbids writing/);
    assert.deepEqual(globalThis[Symbol.for("pi-smoke:guard")], { networkAttempts: 3, deniedWrites: 2 });
  `;
  const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assertPerimeter();
});

const object = (properties, required = Object.keys(properties), extra = false) => ({
  type: "object",
  properties,
  required,
  additionalProperties: extra,
});
const validate = (schema, args) =>
  validateToolArguments(
    { name: "probe", description: "Native validator probe", parameters: schema },
    { type: "toolCall", id: "probe", name: "probe", arguments: args },
  );
function freeze(value) {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}
const builders = {
  TypeBox: (schema) => Type.Object({ value: schema }),
  JSON: (schema) => object({ value: JSON.parse(JSON.stringify(schema)) }),
};
const conversions = [
  ["numeric string", Type.Number(), "42.5", 42.5],
  ["empty numeric string", Type.Number(), "", 0],
  ["boolean to number", Type.Number(), true, 1],
  ["boolean string to number", Type.Number(), "false", 0],
  ["fractional string integer truncates", Type.Integer(), "3.9", 3],
  ["negative integer truncates toward zero", Type.Integer(), -3.9, -3],
  ["boolean casing", Type.Boolean(), "TrUe", true],
  ["false casing", Type.Boolean(), "FALSE", false],
  ["numeric boolean string", Type.Boolean(), "0", false],
  ["numeric boolean", Type.Boolean(), 1, true],
  ["scalar array", Type.Array(Type.Integer()), "2.9", [2]],
  ["array item conversion", Type.Array(Type.Boolean()), ["TRUE", "0"], [true, false]],
  ["required null string", Type.String(), null, "null"],
  ["required null number", Type.Number(), null, 0],
  ["required null boolean", Type.Boolean(), null, false],
  ["null string", Type.Null(), "null", null],
  ["undefined string to null", Type.Null(), "undefined", null],
  ["zero to null", Type.Null(), 0, null],
  ["nullable union retains null", Type.Union([Type.Number(), Type.Null()]), null, null],
  ["nullable union converts fraction", Type.Union([Type.Integer(), Type.Null()]), "3.9", 3],
];
for (const [kind, builder] of Object.entries(builders)) {
  for (const [name, valueSchema, input, expected] of conversions) {
    test(`${kind}: ${name}`, () => {
      const schema = freeze(builder(valueSchema));
      const args = freeze({ value: input });
      const before = structuredClone(args);
      assert.deepEqual(validate(schema, args), { value: expected });
      assert.deepEqual(args, before, "transcript input is immutable");
    });
  }
  test(`${kind}: required, optional, defaults, and invalid values`, () => {
    const properties = {
      required: Type.String(),
      optional: Type.Optional(Type.Number({ default: 7 })),
      nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    };
    const schema = freeze(
      kind === "TypeBox" ? Type.Object(properties, { additionalProperties: false }) : object(properties, ["required"]),
    );
    assert.deepEqual(validate(schema, { required: "ok" }), { required: "ok" }, "no inserted defaults");
    assert.deepEqual(validate(schema, { required: "ok", optional: null, nullable: null }), {
      required: "ok",
      nullable: null,
    });
    assert.throws(() => validate(schema, {}), /required: missing/);
    assert.throws(
      () => validate(builder(Type.Number({ default: 7 })), {}),
      /value: missing/,
      "required defaults are annotations too",
    );
    assert.throws(() => validate(schema, { required: "ok", extra: 1 }), /extra: unknown field/);
    for (const [valueSchema, invalid] of [
      [Type.Number(), "many"],
      [Type.Boolean(), "yes"],
      [Type.Boolean(), 2],
      [Type.Array(Type.Number()), {}],
    ]) {
      assert.throws(() => validate(builder(valueSchema), { value: invalid }), /Validation failed/);
    }
  });
}

test("plain JSON type-array nullable uses primitive coercion, not integer truncation", () => {
  const schema = object({ value: { type: ["integer", "null"] } });
  assert.deepEqual(validate(schema, { value: null }), { value: null });
  assert.deepEqual(validate(schema, { value: "3" }), { value: 3 });
  assert.throws(() => validate(schema, { value: "3.9" }), /Validation failed/);
  assert.throws(
    () => validate(object({ value: { type: ["boolean", "null"] } }), { value: "TRUE" }),
    /Validation failed/,
  );
});

test("unions retain already-valid values, otherwise convert in branch order", () => {
  for (const keyword of ["anyOf", "oneOf"]) {
    assert.equal(
      validate(object({ value: { [keyword]: [{ type: "number" }, { type: "boolean" }] } }), { value: "true" }).value,
      1,
    );
    assert.equal(
      validate(object({ value: { [keyword]: [{ type: "boolean" }, { type: "number" }] } }), { value: "true" }).value,
      true,
    );
    assert.equal(
      validate(object({ value: { [keyword]: [{ type: "number" }, { type: "string" }] } }), { value: "42" }).value,
      "42",
    );
  }
});

test("local, dangling and recursive refs use host policy; strict qualification catches dangling refs", () => {
  const local = { ...object({ value: { $ref: "#/$defs/count" } }), $defs: { count: { type: "integer" } } };
  assert.deepEqual(validate(local, { value: "4.8" }), { value: 4 });
  const dangling = object({ optional: { $ref: "#/$defs/missing" }, other: { type: "string" } }, ["other"]);
  assert.throws(() => compile(dangling), /Unresolved \$ref/);
  assert.deepEqual(validate(dangling, { other: "ok" }), { other: "ok" });
  assert.throws(() => validate(dangling, { other: "ok", optional: 1 }), /optional: unresolved reference/);
  const tree = {
    $ref: "#/$defs/node",
    $defs: {
      node: object({ value: { type: "integer" }, children: { type: "array", items: { $ref: "#/$defs/node" } } }, [
        "value",
      ]),
    },
  };
  const input = freeze({ value: "1.9", children: [{ value: "2" }] });
  assert.deepEqual(validate(tree, input), { value: 1, children: [{ value: 2 }] });
  assert.equal(input.value, "1.9");
  assert.throws(
    () => validate(tree, { value: 1, children: [{ value: "bad" }] }),
    /children.0.value: expected integer, got string/,
  );
  const recursiveUnion = {
    $defs: { node: { anyOf: [{ type: "number" }, { type: "array", items: { $ref: "#/$defs/node" } }] } },
    $ref: "#/$defs/node",
  };
  assert.deepEqual(validate(recursiveUnion, ["2", ["3"]]), [2, [3]]);
  assert.throws(() => validate(recursiveUnion, {}), /Validation failed/);
});

test("tuples do not scalar-wrap; legacy additionalItems do not coerce", () => {
  const tuple = { type: "array", prefixItems: [{ type: "integer" }, { type: "boolean" }], minItems: 2, items: false };
  assert.deepEqual(validate(tuple, ["3.8", "TRUE"]), [3, true]);
  assert.throws(() => validate(tuple, "3"), /root: expected array/);
  assert.throws(() => validate(tuple, [1, true, 3]), /Validation failed/);
  const legacy = { type: "array", items: [{ type: "integer" }], additionalItems: { type: "integer" } };
  assert.deepEqual(validate(legacy, ["2.9", 3]), [2, 3]);
  assert.throws(() => validate(legacy, ["2", "3"]), /1: expected integer, got string/);
});

test("literal property names, extras, escaped pointers and model-facing errors", () => {
  const schema = object({ "a/b~c": { type: "array", items: object({ "literal.*": { type: "number" } }) } });
  const bad = { "a/b~c": [{ "literal.*": "bad" }] };
  const result = compile(schema, { coerce: true }).parse(bad);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    { path: "/a~1b~0c/0/literal.*", keyword: "type", message: "expected number, got string" },
  ]);
  assert.throws(() => validate(schema, bad), /a\/b~c.0.literal\.\*: expected number, got string/);
  assert.deepEqual(validate(object({ "a.b": { type: "string" } }, [], true), { extra: 1 }), { extra: 1 });
  assert.throws(() => validate(object({ "a.b": { type: "string" } }, []), { axb: 1 }), /axb: unknown field/);
  const unchanged = { value: { nested: true } };
  const passed = validate(object({ value: {} }), unchanged);
  passed.value.nested = false;
  assert.equal(unchanged.value.nested, true, "host clones even unchanged accepted inputs");
});

test("real AgentSession faux tool calls separate schema coercion, execute defaults and business guards", async () => {
  const cwd = process.env.PI_SMOKE_SANDBOX;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  assert.ok(cwd && agentDir);
  const faux = fauxProvider({
    provider: "schema-qualification",
    models: [{ id: "offline", reasoning: false, contextWindow: 200000, maxTokens: 1024 }],
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(cwd, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  let executions = 0;
  let sideEffects = 0;
  const received = [];
  const parameters = Type.Object(
    { count: Type.Integer(), note: Type.Optional(Type.String({ default: "schema-default" })) },
    { additionalProperties: false },
  );
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        for (const [name, schema] of [
          ["guarded_probe", parameters],
          ["guarded_json_probe", JSON.parse(JSON.stringify(parameters))],
        ])
          pi.registerTool({
            name,
            label: "Probe",
            description: "Offline qualification",
            parameters: schema,
            async execute(_id, args) {
              executions++;
              received.push(structuredClone(args));
              if (args.count < 0) throw new Error("business guard: count must be nonnegative");
              sideEffects++;
              args.count = 999; // A tool may mutate its private execution copy, not the transcript.
              return { content: [{ type: "text", text: args.note ?? "execute-default" }], details: {} };
            },
          });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime: runtime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: loader,
    tools: ["guarded_probe", "guarded_json_probe"],
  });
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(String(error)) });
  try {
    const calls = [
      ["coerced", { count: "3.9", note: null }, false, "execute-default"],
      ["invalid", { count: {} }, true, "Validation failed"],
      ["missing", {}, true, "count: missing"],
      ["extra", { count: 1, extra: true }, true, "unknown field"],
      ["business", { count: -1 }, true, "business guard"],
    ];
    for (const name of ["guarded_probe", "guarded_json_probe"]) {
      for (const [suffix, args, isError, text] of calls) {
        const id = `${name}-${suffix}`;
        const originalArgs = structuredClone(args);
        const call = fauxToolCall(name, args, { id });
        faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
        await session.prompt("Run the scripted offline qualification call.");
        const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
        assert.ok(result, `missing tool result ${id}`);
        assert.equal(result.isError, isError);
        assert.ok(
          result.content.some((block) => block.type === "text" && block.text.includes(text)),
          JSON.stringify(result),
        );
        assert.deepEqual(call.arguments, originalArgs, "execution must not change provider arguments");
        const recordedCall = session.messages
          .flatMap((message) => (message.role === "assistant" ? message.content : []))
          .find((block) => block.type === "toolCall" && block.id === id);
        assert.deepEqual(recordedCall.arguments, originalArgs, "tool mutations must not change the session transcript");
      }
    }
    assert.equal(executions, 4, "invalid schema calls must not enter execute");
    assert.equal(sideEffects, 2, "invalid and business-guarded calls have no spy side effect");
    assert.deepEqual(
      received,
      [{ count: 3 }, { count: -1 }, { count: 3 }, { count: -1 }],
      "defaults are not inserted before execute",
    );
    assert.equal(faux.state.callCount, 20);
    assert.deepEqual(errors, []);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assertPerimeter();
  } finally {
    session.dispose();
  }
});

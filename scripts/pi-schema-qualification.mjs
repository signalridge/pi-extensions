import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

// Qualification is intentionally pinned, not an alternate runtime validator.
export function assertExactHost() {
  for (const [name, version] of [
    ["@earendil-works/pi-coding-agent", "1.5.0"],
    ["@earendil-works/pi-agent-core", "1.5.0"],
    ["@earendil-works/pi-ai", "1.5.0"],
    ["@earendil-works/pi-schema", "1.5.0"],
    ["@earendil-works/pi-tui", "1.5.0"],
    ["typebox", "1.3.27"],
  ]) {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    while (true) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (manifest.name === name) {
          assert.equal(manifest.version, version, `${name} qualification requires exact ${version}`);
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      assert.notEqual(parent, directory, `cannot find ${name} manifest`);
      directory = parent;
    }
  }
}

export function assertPerimeter() {
  const guard = globalThis[Symbol.for("pi-smoke:guard")];
  assert.ok(guard, "native qualification must run through run-pi-smoke.mjs");
  assert.deepEqual(guard, { networkAttempts: 0, deniedWrites: 0 });
}

function inspectSchema(value, stack = new Set()) {
  assert.ok(!["function", "bigint", "undefined"].includes(typeof value), "non-JSON schema value");
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  if (!value || typeof value !== "object") return;
  assert.ok(!stack.has(value), "cyclic JS schema (use JSON $ref instead)");
  stack.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(Object.hasOwn(descriptor, "value"), "schema accessor");
    inspectSchema(descriptor.value, stack);
  }
  stack.delete(value);
}

const samples = [
  ["Agent", { prompt: "Schema probe; never executed", description: "Schema probe", subagent_type: "Explore" }],
  ["get_subagent_result", { agent_id: "not-executed", wait: false }],
  ["workflow", { script: 'export const meta={name:"probe",description:"not executed"}; return 0;', background: true }],
  ["workflow_control", { action: "list" }],
  ["todo", { action: "list" }],
  ["bash_background", { command: "not executed" }],
  ["monitor", { command: "not executed", patterns: ["ready"] }],
  ["goal_complete", { goal_id: "not-executed", summary: "Schema validation only" }],
  ["goal_wait", { goal_id: "not-executed", reason: "Schema validation only" }],
  [
    "ask_user_question",
    { questions: [{ id: "probe", question: "Probe?", options: [{ label: "One" }, { label: "Two" }] }] },
  ],
];

export function qualifySessionSchemas(session, label, { requireSamples = false } = {}) {
  // Public runner discovery includes inactive tools, unlike only the model loadout.
  const definitions = session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition);
  const names = definitions.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length, `${label}: duplicate tools`);
  for (const tool of definitions) {
    inspectSchema(tool.parameters);
    assert.doesNotThrow(() => compile(tool.parameters, { formats, coerce: true, unresolvedRefs: "throw" }), tool.name);
  }
  const probes = [];
  for (const [name, args] of samples) {
    const tool = definitions.find((tool) => tool.name === name);
    if (!tool) {
      if (requireSamples && ["Agent", "workflow"].includes(name)) assert.fail(`${label}: missing ${name}`);
      continue;
    }
    validateToolArguments(tool, { type: "toolCall", id: "schema-only", name, arguments: args });
    probes.push(name);
  }
  for (const [name, args] of [
    ["Agent", {}],
    ["workflow", { script: {} }],
    ["todo", { action: "not-an-action" }],
  ]) {
    const tool = definitions.find((tool) => tool.name === name);
    if (tool)
      assert.throws(
        () => validateToolArguments(tool, { type: "toolCall", id: "invalid", name, arguments: args }),
        /Validation failed/,
      );
  }
  console.log(
    `schema: ${label}: ${definitions.length} session-registered schemas compiled; probes=${probes.join(",")}`,
  );
  return { tools: names, probes };
}

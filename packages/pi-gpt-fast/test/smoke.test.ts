import { test } from "bun:test";
import assert from "node:assert/strict";
import gptFast from "../src/index.js";

test("registers the flag, command, and model lifecycle hooks", () => {
  const flags: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  gptFast({
    registerFlag: (name: string) => flags.push(name),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string) => events.push(event),
    getFlag: () => false,
  } as never);
  assert.deepEqual(flags, ["gpt-fast"]);
  assert.deepEqual(commands, ["gpt-fast"]);
  assert.deepEqual(events, ["session_start", "model_select", "before_provider_request"]);
});

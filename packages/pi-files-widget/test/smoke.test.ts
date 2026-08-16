import { test } from "bun:test";
import assert from "node:assert/strict";
import filesWidget from "../index.js";

test("registers the file browser command and lifecycle hooks", () => {
  const commands: string[] = [];
  const events: string[] = [];
  filesWidget({
    registerCommand: (name: string) => commands.push(name),
    on: (event: string) => events.push(event),
  } as never);
  assert.deepEqual(commands, ["readfiles"]);
  assert.deepEqual(events, ["tool_result", "session_start", "session_before_switch"]);
});

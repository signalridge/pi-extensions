import { test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus from "../tab-status.js";

test("registers the tab status lifecycle hooks", () => {
  const events: string[] = [];
  tabStatus({ on: (event: string) => events.push(event) } as never);
  assert.deepEqual(events, [
    "session_start",
    "session_before_switch",
    "before_agent_start",
    "agent_start",
    "turn_start",
    "tool_call",
    "tool_result",
    "agent_end",
    "session_shutdown",
  ]);
});

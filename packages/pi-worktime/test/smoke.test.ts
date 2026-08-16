import assert from "node:assert/strict";
import publicWorktime, {
  parseWorktimeUpdatePayload as parseFromRoot,
  WORKTIME_UPDATE_EVENT as rootEvent,
} from "@signalridge/pi-worktime";
import { parseWorktimeUpdatePayload, WORKTIME_UPDATE_EVENT } from "@signalridge/pi-worktime/events";
import { test } from "vitest";
import worktime from "../src/index.js";

test("registers the worktime command and lifecycle hooks", () => {
  const events: string[] = [];
  const commands: string[] = [];

  worktime({
    on(event: string) {
      events.push(event);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
  } as never);

  assert.deepEqual(events, [
    "session_start",
    "session_tree",
    "message_start",
    "agent_start",
    "agent_end",
    "session_shutdown",
  ]);
  assert.deepEqual(commands, ["worktime"]);
});

test("bare and events public specifiers expose typed source exports", () => {
  assert.equal(publicWorktime, worktime);
  assert.equal(rootEvent, WORKTIME_UPDATE_EVENT);
  assert.equal(WORKTIME_UPDATE_EVENT, "worktime:update");
  assert.deepEqual(parseFromRoot({ ms: 1, running: true }), { ms: 1, running: true });
  assert.deepEqual(parseWorktimeUpdatePayload({ ms: 2, running: false }), { ms: 2, running: false });
});

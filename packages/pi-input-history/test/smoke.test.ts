import assert from "node:assert/strict";
import { test } from "vitest";
import history from "../src/index.js";

test("registers session loading and Ctrl+R history handlers", () => {
  const events = new Set<string>();
  let shortcut = "";
  const pi = {
    on(event: string) {
      events.add(event);
    },
    registerShortcut(key: string) {
      shortcut = key;
    },
  };

  history(pi as never);

  assert.deepEqual([...events], ["session_start", "session_shutdown"]);
  assert.equal(shortcut, "ctrl+r");
});

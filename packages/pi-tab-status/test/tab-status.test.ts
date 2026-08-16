import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatIdleTabTitle, formatTabTitle } from "../tab-status.js";

test("Ridgeline tab titles are compact and text-only", () => {
  assert.equal(formatIdleTabTitle("/workspace/pi-extensions", "ridgeline"), "pi · pi-extensions");
  assert.equal(formatTabTitle("/workspace/pi-extensions", "running", "ridgeline"), "pi · pi-extensions · working");
  assert.equal(formatTabTitle("/workspace/pi-extensions", "doneCommitted", "ridgeline"), "pi · pi-extensions · done");
  assert.equal(formatTabTitle("/workspace/pi-extensions", "doneNoCommit", "ridgeline"), "pi · pi-extensions · review");
  assert.equal(formatTabTitle("/workspace/pi-extensions", "timeout", "ridgeline"), "pi · pi-extensions · blocked");
});

test("legacy tab titles remain available for rollback", () => {
  assert.equal(formatIdleTabTitle("/workspace/pi-extensions", "legacy"), "pi - pi-extensions");
  assert.equal(formatTabTitle("/workspace/pi-extensions", "running", "legacy"), "pi - pi-extensions:running...");
  assert.equal(formatTabTitle("/workspace/pi-extensions", "doneCommitted", "legacy"), "pi - pi-extensions:✅");
});

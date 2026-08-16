import assert from "node:assert/strict";
import { registerSessionCompactRefresh } from "../src/context-refresh.ts";

let handler;
const registrar = {
  on(event, callback) {
    assert.equal(event, "session_compact");
    handler = callback;
  },
};
let refreshCount = 0;

registerSessionCompactRefresh(registrar, () => {
  refreshCount += 1;
});

assert.equal(typeof handler, "function");
handler();
assert.equal(refreshCount, 1);

console.log("test_pi_statusline_context_refresh: OK");

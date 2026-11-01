import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatNotification, resolveNotifyProtocol, sanitizeNotificationText, wrapForTmux } from "../notify.js";

test("notifications stay off unless the setting enables them", () => {
  assert.equal(resolveNotifyProtocol({}), undefined);
  assert.equal(resolveNotifyProtocol({ PI_TAB_STATUS_NOTIFY: "" }), undefined);
  assert.equal(resolveNotifyProtocol({ PI_TAB_STATUS_NOTIFY: "0" }), undefined);
  assert.equal(resolveNotifyProtocol({ PI_TAB_STATUS_NOTIFY: "true" }), undefined);
  assert.equal(resolveNotifyProtocol({ PI_TAB_STATUS_NOTIFY: "OSC9" }), undefined);
});

test("auto-detection picks the protocol each terminal implements", () => {
  const on = { PI_TAB_STATUS_NOTIFY: "1" };
  assert.equal(resolveNotifyProtocol(on), "osc777");
  assert.equal(resolveNotifyProtocol({ ...on, TERM_PROGRAM: "ghostty" }), "osc777");
  assert.equal(resolveNotifyProtocol({ ...on, TERM_PROGRAM: "iTerm.app" }), "osc9");
  assert.equal(
    resolveNotifyProtocol({
      ...on,
      TERM_PROGRAM: "tmux",
      ITERM_SESSION_ID: "w0t0p0:1",
    }),
    "osc9",
  );
  assert.equal(resolveNotifyProtocol({ ...on, LC_TERMINAL: "iTerm2" }), "osc9");
  assert.equal(resolveNotifyProtocol({ ...on, KITTY_WINDOW_ID: "1" }), "osc99");
  assert.equal(
    resolveNotifyProtocol({
      ...on,
      KITTY_WINDOW_ID: "1",
      LC_TERMINAL: "iTerm2",
    }),
    "osc99",
  );
});

test("a protocol name overrides detection", () => {
  assert.equal(
    resolveNotifyProtocol({
      PI_TAB_STATUS_NOTIFY: "osc777",
      KITTY_WINDOW_ID: "1",
    }),
    "osc777",
  );
  assert.equal(
    resolveNotifyProtocol({
      PI_TAB_STATUS_NOTIFY: "osc9",
      TERM_PROGRAM: "tmux",
    }),
    "osc9",
  );
  assert.equal(resolveNotifyProtocol({ PI_TAB_STATUS_NOTIFY: "osc99" }), "osc99");
});

test("each protocol produces its terminal's notification sequence", () => {
  assert.equal(formatNotification("osc777", "pi - demo", "Done", {}), "\x1b]777;notify;pi - demo;Done\x07");
  assert.equal(formatNotification("osc9", "pi - demo", "Done", {}), "\x1b]9;pi - demo: Done\x07");
  assert.equal(
    formatNotification("osc99", "pi - demo", "Done", {}),
    "\x1b]99;i=1:d=0;pi - demo\x1b\\\x1b]99;i=1:p=body;Done\x1b\\",
  );
});

test("inside tmux every sequence is wrapped for passthrough with inner ESC doubled", () => {
  const tmux = { TMUX: "/tmp/tmux-501/default,123,0" };
  assert.equal(wrapForTmux("\x1b]9;hi\x07", {}), "\x1b]9;hi\x07");
  assert.equal(
    formatNotification("osc777", "pi - demo", "Done", tmux),
    "\x1bPtmux;\x1b\x1b]777;notify;pi - demo;Done\x07\x1b\\",
  );
  assert.equal(
    formatNotification("osc99", "pi - demo", "Done", tmux),
    "\x1bPtmux;\x1b\x1b]99;i=1:d=0;pi - demo\x1b\x1b\\\x1b\\\x1bPtmux;\x1b\x1b]99;i=1:p=body;Done\x1b\x1b\\\x1b\\",
  );
});

test("controls, bidi overrides and field separators cannot escape the sequence", () => {
  const sequence = formatNotification("osc777", "evil\x07\x1b]0;owned\x1b\\\u202edir", "a;b\nc\u009cd", {});
  assert.equal(sequence, "\x1b]777;notify;evil ]0,owned \\ dir;a,b c d\x07");
  assert.equal(sanitizeNotificationText(`${"x".repeat(200)}`), "x".repeat(160));
  assert.equal(sanitizeNotificationText(`${"x".repeat(159)} tail`), "x".repeat(159));
});

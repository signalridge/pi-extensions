import { appendFile } from "node:fs/promises";
import { BashExecutionComponent, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { validateEntryPayload } from "../src/session-payload.js";
import { vetSession } from "../src/storage.js";
import { fixture, response } from "./support.js";

initTheme("dark", false);
const bash = {
  role: "bashExecution",
  command: "echo ok",
  output: "ok",
  exitCode: 0,
  cancelled: false,
  truncated: false,
  timestamp: 1,
};

test.each([
  { ...bash, output: {} },
  { ...bash, command: {} },
  { ...bash, cancelled: "no" },
  { ...bash, truncated: null },
  { ...bash, exitCode: "0" },
  { role: "branchSummary", summary: {}, fromId: null, timestamp: 1 },
  { role: "compactionSummary", summary: "text", tokensBefore: {}, timestamp: 1 },
  { role: "custom", content: "text", display: false, timestamp: 1 },
  { role: "unknownNativeRole", timestamp: 1 },
])("rejects malformed or unsupported persisted native role $role", (message) => {
  expect(() => validateEntryPayload({ type: "message", message }, new Map())).toThrow();
});

test("valid public native message roles remain accepted", () => {
  for (const message of [
    bash,
    { ...bash, exitCode: undefined, fullOutputPath: "/tmp/output", excludeFromContext: true },
    { role: "branchSummary", summary: "summary", fromId: null, timestamp: 1 },
    { role: "compactionSummary", summary: "summary", tokensBefore: 12, timestamp: 1 },
    { role: "custom", customType: "test", content: "text", display: false, timestamp: 1 },
    { role: "user", content: "text", timestamp: 1 },
    { role: "system", content: [{ type: "text", text: "system" }], timestamp: 1 },
    response("assistant"),
    { role: "toolResult", toolCallId: "call", toolName: "test", content: [], isError: false, timestamp: 1 },
  ])
    expect(() => validateEntryPayload({ type: "message", message }, new Map())).not.toThrow();
});

test("malformed bash output crashes the native renderer but is rejected before native switch", async () => {
  const terminal: Terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  const tui = new TuiMainScreen(terminal);
  const component = new BashExecutionComponent("echo ok", tui);
  try {
    expect(() => component.appendOutput({} as never)).toThrow();
  } finally {
    component.setComplete(0, false);
    tui.stop();
  }
  const f = await fixture({ ui: { input: async () => "" } });
  try {
    const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
    const parentId = target.appendMessage({ role: "user", content: "valid", timestamp: 1 });
    const path = target.getSessionFile() as string;
    await appendFile(
      path,
      `${JSON.stringify({ type: "message", id: "bad-bash", parentId, timestamp: new Date().toISOString(), message: { ...bash, output: {} } })}\n`,
    );
    f.ui.select = async (_title, options) => options.find((option) => option.includes(target.getSessionId()));
    const switchSession = vi.spyOn(f.runtime, "switchSession");
    await f.command("sessions");
    expect(switchSession).not.toHaveBeenCalled();
    expect(f.source.extensionRunner.createCommandContext().isIdle()).toBe(true);
    await expect(vetSession(path, target.getSessionId(), new AbortController().signal)).rejects.toThrow();
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

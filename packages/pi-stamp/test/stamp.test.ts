import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { DEFAULT_STAMP_SETTINGS, type StampSettings } from "../src/format.js";
import { captureAssistantMetadata } from "../src/metadata.js";
import type { StampSettingsRuntime, StampSettingsState } from "../src/settings.js";
import stamp, {
  createStampEntryRenderer,
  formatStampTime,
  isMessageStampData,
  isToolStampData,
  STAMP_ENTRY_TYPE,
} from "../src/stamp.js";
import { createMockContext, createMockPi } from "./support.js";

const USER_TIMESTAMP = new Date(2026, 0, 2, 5, 6, 7, 123).getTime();
const ASSISTANT_TIMESTAMP = new Date(2026, 0, 2, 5, 6, 9, 456).getTime();

test("stamp registers one entry renderer, one menu command, and no tools", () => {
  const mock = createMockPi();
  stamp(mock.pi);

  assert.deepEqual([...mock.entryRenderers.keys()], [STAMP_ENTRY_TYPE]);
  assert.deepEqual([...mock.commands.keys()], ["stamp"]);
  assert.equal(mock.tools.length, 0);
  assert.deepEqual([...mock.events.keys()].sort(), [
    "agent_end",
    "message_end",
    "message_start",
    "message_update",
    "session_shutdown",
    "session_start",
    "tool_execution_end",
    "tool_execution_start",
    "turn_end",
    "turn_start",
  ]);
});

test("formatStampTime uses zero-padded local 24-hour time and rejects invalid values", () => {
  assert.equal(formatStampTime(USER_TIMESTAMP), "05:06:07");
  assert.equal(formatStampTime(Number.NaN), undefined);
  assert.equal(formatStampTime(Number.POSITIVE_INFINITY), undefined);
  assert.equal(formatStampTime(10 ** 20), undefined);
});

test("isMessageStampData accepts exact message versions 1 through 4", () => {
  assert.equal(isMessageStampData({ version: 1, role: "user", timestamp: USER_TIMESTAMP }), true);
  assert.equal(isMessageStampData({ version: 2, role: "assistant", timestamp: ASSISTANT_TIMESTAMP }), true);
  assert.equal(
    isMessageStampData({
      version: 2,
      role: "user",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: USER_TIMESTAMP - 1_000,
    }),
    true,
  );
  assert.equal(
    isMessageStampData({
      version: 1,
      role: "user",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: USER_TIMESTAMP - 1_000,
    }),
    false,
  );
  assert.equal(
    isMessageStampData({
      version: 2,
      role: "user",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: NaN,
    }),
    false,
  );
  assert.equal(
    isMessageStampData({
      version: 3,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: USER_TIMESTAMP - 1_000,
      completedAt: USER_TIMESTAMP + 3_200,
      firstContentAt: USER_TIMESTAMP + 800,
    }),
    true,
  );
  const metadata = captureAssistantMetadata(assistantMessage(ASSISTANT_TIMESTAMP));
  assert.ok(metadata);
  assert.equal(
    isMessageStampData({
      version: 4,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      previousTimestamp: USER_TIMESTAMP - 1_000,
      completedAt: USER_TIMESTAMP + 3_200,
      firstContentAt: USER_TIMESTAMP + 800,
      metadata,
    }),
    true,
  );
  assert.equal(isMessageStampData({ version: 4, role: "assistant", timestamp: USER_TIMESTAMP, metadata }), true);
  for (const value of [
    {
      version: 3,
      role: "user",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 1_000,
    },
    { version: 3, role: "assistant", timestamp: USER_TIMESTAMP },
    {
      version: 3,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP - 1,
    },
    {
      version: 3,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 1_000,
      firstContentAt: USER_TIMESTAMP + 2_000,
    },
    {
      version: 3,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 1_000,
      future: true,
    },
    { version: 4, role: "user", timestamp: USER_TIMESTAMP, metadata },
    { version: 4, role: "assistant", timestamp: USER_TIMESTAMP },
    {
      version: 4,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      firstContentAt: USER_TIMESTAMP + 1,
      metadata,
    },
    {
      version: 4,
      role: "assistant",
      timestamp: USER_TIMESTAMP,
      completedAt: USER_TIMESTAMP + 1_000,
      metadata: { ...metadata, future: true },
    },
  ]) {
    assert.equal(isMessageStampData(value), false);
  }
  assert.equal(isMessageStampData({ version: 1, role: "toolResult", timestamp: USER_TIMESTAMP }), false);
  assert.equal(isMessageStampData({ version: 1, role: "user", timestamp: Number.NaN }), false);
  assert.equal(isMessageStampData(null), false);
});

test("isToolStampData accepts only exact ordered version-1 tool observations", () => {
  const valid = {
    version: 1,
    kind: "tool",
    toolCallId: "call-1",
    toolName: "read",
    startedAt: USER_TIMESTAMP,
    completedAt: USER_TIMESTAMP + 1_250,
    outcome: "success",
  };
  assert.equal(isToolStampData(valid), true);
  assert.equal(isToolStampData({ ...valid, outcome: "error" }), true);
  for (const value of [
    { ...valid, version: 2 },
    { ...valid, kind: "message" },
    { ...valid, toolCallId: "" },
    { ...valid, toolName: "x".repeat(161) },
    { ...valid, completedAt: USER_TIMESTAMP - 1 },
    { ...valid, outcome: "cancelled" },
    { ...valid, future: true },
  ]) {
    assert.equal(isToolStampData(value), false);
  }
});

test("entry renderer reads live settings, uses the callback theme, and stays width-safe", () => {
  let settings: StampSettings = { ...DEFAULT_STAMP_SETTINGS, timeZone: "UTC" };
  const renderer = createStampEntryRenderer(() => settings);
  const colors: string[] = [];
  const component = renderer(
    {
      data: {
        version: 2,
        role: "user",
        timestamp: Date.UTC(2026, 6, 30, 0, 1, 2),
        previousTimestamp: Date.UTC(2026, 6, 29, 23, 59, 58),
      },
    } as never,
    { expanded: false },
    {
      fg(color: string, text: string) {
        colors.push(color);
        return text;
      },
    } as never,
  );

  assert.ok(component);
  assert.equal(component.render(30).join("\n"), "         2026-07-30 · 00:01:02");
  settings = { ...settings, showSeconds: false, dateContext: "never" };
  assert.equal(component.render(12).join("\n"), "       00:01");
  settings = { ...settings, showSeconds: true, responseTiming: "duration" };
  const timedComponent = renderer(
    {
      data: {
        version: 3,
        role: "assistant",
        timestamp: Date.UTC(2026, 6, 30, 0, 1, 2),
        completedAt: Date.UTC(2026, 6, 30, 0, 1, 5, 200),
        firstContentAt: Date.UTC(2026, 6, 30, 0, 1, 2, 800),
      },
    } as never,
    { expanded: false },
    { fg: (_color: string, text: string) => text } as never,
  );
  assert.ok(timedComponent);
  assert.equal(timedComponent.render(50).join("\n").trim(), "00:01:02 · 3.2s");
  settings = { ...settings, responseTiming: "detailed" };
  assert.equal(timedComponent.render(50).join("\n"), "                00:01:02 · first 0.8s · total 3.2s");
  assert.deepEqual(colors, ["dim", "dim"]);
  const renderedComponents = [component, timedComponent];
  for (const width of [1, 4, 8, 10]) {
    for (const renderedComponent of renderedComponents) {
      for (const line of renderedComponent.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} exceeded width ${width}`);
      }
    }
  }

  assert.equal(renderer({ data: { version: 99 } } as never, { expanded: false }, { fg: () => "" } as never), undefined);
});

test("entry renderer composes opt-in assistant metadata, explicit debug details, and tool stamps", () => {
  let settings: StampSettings = {
    ...DEFAULT_STAMP_SETTINGS,
    timeZone: "UTC",
    assistantMetadata: "compact",
  };
  const renderer = createStampEntryRenderer(() => settings);
  const assistant = {
    ...assistantMessage(Date.UTC(2026, 6, 30, 0, 1, 2)),
    responseModel: "actual-model",
    responseId: "response-1",
    diagnostics: [
      {
        type: "retry",
        timestamp: Date.UTC(2026, 6, 30, 0, 1, 3),
        error: { name: "HTTPError", code: 429, message: "raw secret" },
      },
    ],
  };
  const metadata = captureAssistantMetadata(assistant);
  assert.ok(metadata);
  const data = {
    version: 4,
    role: "assistant",
    timestamp: assistant.timestamp,
    completedAt: assistant.timestamp + 3_200,
    firstContentAt: assistant.timestamp + 800,
    metadata,
  } as const;
  const theme = { fg: (_color: string, text: string) => text } as never;
  const compact = renderer({ data } as never, { expanded: false }, theme);
  assert.ok(compact);
  assert.deepEqual(
    compact.render(80).map((line) => line.trim()),
    ["00:01:02", "test-model → actual-model · 2 tok · est $0"],
  );

  settings = { ...settings, assistantMetadata: "expanded", responseTiming: "duration" };
  const debug = renderer({ data } as never, { expanded: true }, theme);
  assert.ok(debug);
  assert.deepEqual(
    debug.render(120).map((line) => line.trim()),
    [
      "00:01:02 · 3.2s",
      "api anthropic-messages · provider anthropic · requested test-model · response actual-model · stop stop",
      "tokens in 1 · out 1 · cache read 0 · cache write 0 · total 2 · est cost $0",
      "debug · response id response-1",
      "debug · diagnostics 1",
      "debug · retry · HTTPError · code 429",
    ],
  );
  assert.equal(debug.render(120).join("\n").includes("raw secret"), false);

  settings = { ...settings, toolStamps: false };
  const toolEntry = {
    data: {
      version: 1,
      kind: "tool",
      toolCallId: "call-1",
      toolName: "read",
      startedAt: assistant.timestamp,
      completedAt: assistant.timestamp + 1_250,
      outcome: "success",
    },
  } as never;
  assert.equal(renderer(toolEntry, { expanded: false }, theme), undefined);
  settings = { ...settings, toolStamps: true };
  const tool = renderer(toolEntry, { expanded: false }, theme);
  assert.ok(tool);
  assert.deepEqual(
    tool.render(80).map((line) => line.trim()),
    ["tool read · 1.3s · success"],
  );
  settings = { ...settings, toolStamps: false };
  assert.deepEqual(tool.render(80), []);
  settings = { ...settings, toolStamps: true };
  for (const width of [1, 4, 8, 12]) {
    for (const line of [...debug.render(width), ...tool.render(width)]) {
      assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} exceeded width ${width}`);
    }
  }
});

test("Pi persists stamp entries across reopen without adding them to model context", (t) => {
  const sessionDir = mkdtempSync(`${os.tmpdir()}/pi-stamp-session-`);
  t.onTestFinished(() => rmSync(sessionDir, { recursive: true, force: true }));
  const session = SessionManager.create(process.cwd(), sessionDir);
  const metadata = captureAssistantMetadata(assistantMessage(ASSISTANT_TIMESTAMP));
  assert.ok(metadata);
  const stampData = {
    version: 4,
    role: "assistant",
    timestamp: USER_TIMESTAMP,
    previousTimestamp: USER_TIMESTAMP - 1_000,
    completedAt: USER_TIMESTAMP + 3_200,
    firstContentAt: USER_TIMESTAMP + 800,
    metadata,
  } as const;

  session.appendMessage(userMessage(USER_TIMESTAMP));
  session.appendCustomEntry(STAMP_ENTRY_TYPE, stampData);
  session.appendMessage(assistantMessage(ASSISTANT_TIMESTAMP));
  const sessionFile = session.getSessionFile();
  assert.ok(sessionFile);

  const reopened = SessionManager.open(sessionFile, sessionDir);
  assert.deepEqual(
    reopened.getBranch().map((entry) => entry.type),
    ["message", "custom", "message"],
  );
  const restoredStamp = reopened.getBranch().at(1);
  assert.equal(restoredStamp?.type, "custom");
  if (restoredStamp?.type !== "custom") assert.fail("Expected restored custom stamp entry");
  assert.equal(restoredStamp.customType, STAMP_ENTRY_TYPE);
  assert.deepEqual(restoredStamp.data, stampData);
  assert.deepEqual(
    reopened.buildSessionContext().messages.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("TUI lifecycle appends one user stamp before the assistant and measured assistant timing at turn end", async () => {
  const mock = createMockPi();
  const times = [ASSISTANT_TIMESTAMP + 800, ASSISTANT_TIMESTAMP + 3_200];
  stamp(mock.pi, {
    settingsRuntime: testSettingsRuntime(),
    now: () => times.shift() ?? assert.fail("Unexpected clock read"),
  });
  const { ctx } = createMockContext({ mode: "tui" });
  const user = userMessage(USER_TIMESTAMP);
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: user }, ctx);
  await emit(mock, "message_end", { message: user }, ctx);
  assert.deepEqual(mock.entries, []);

  await emit(mock, "message_start", { message: assistant }, ctx);
  assert.deepEqual(mock.entries, [stampEntry("user", USER_TIMESTAMP)]);
  await emit(
    mock,
    "message_update",
    { message: assistant, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
    ctx,
  );
  await emit(
    mock,
    "message_update",
    { message: assistant, assistantMessageEvent: { type: "text_delta", delta: "" } },
    ctx,
  );
  await emit(
    mock,
    "message_update",
    { message: assistant, assistantMessageEvent: { type: "text_delta", delta: "hello" } },
    ctx,
  );
  await emit(mock, "message_end", { message: assistant }, ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(mock.entries, [
    stampEntry("user", USER_TIMESTAMP),
    timedAssistantStamp(ASSISTANT_TIMESTAMP, ASSISTANT_TIMESTAMP + 3_200, {
      previousTimestamp: USER_TIMESTAMP,
      firstContentAt: ASSISTANT_TIMESTAMP + 800,
    }),
  ]);

  await emit(mock, "agent_end", { messages: [user, assistant] }, ctx);
  await emit(mock, "session_shutdown", { reason: "quit" }, ctx);
  assert.equal(mock.entries.length, 2);
  assert.deepEqual(mock.sentMessages, []);
  assert.deepEqual(mock.sentUserMessages, []);
});

test("opt-in assistant metadata persists a sanitized version-4 snapshot with measured timing", async () => {
  const mock = createMockPi();
  const runtime = settingsRuntimeWith({ assistantMetadata: "compact" });
  stamp(mock.pi, {
    settingsRuntime: runtime,
    now: () => ASSISTANT_TIMESTAMP + 3_200,
  });
  const { ctx } = createMockContext({ mode: "tui" });
  const assistant = {
    ...assistantMessage(ASSISTANT_TIMESTAMP),
    responseModel: "reported-model",
    responseId: "response-1",
  };
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);
  await emit(mock, "message_end", { message: assistant }, ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  const metadata = captureAssistantMetadata(assistant);
  assert.ok(metadata);
  assert.deepEqual(mock.entries, [
    {
      customType: STAMP_ENTRY_TYPE,
      data: {
        version: 4,
        role: "assistant",
        timestamp: ASSISTANT_TIMESTAMP,
        completedAt: ASSISTANT_TIMESTAMP + 3_200,
        metadata,
      },
    },
  ]);

  const reversed = createMockPi();
  stamp(reversed.pi, {
    settingsRuntime: settingsRuntimeWith({ assistantMetadata: "compact" }),
    now: () => ASSISTANT_TIMESTAMP - 1,
  });
  await emit(reversed, "session_start", { reason: "startup" }, ctx);
  await emit(reversed, "message_start", { message: assistant }, ctx);
  await emit(reversed, "message_end", { message: assistant }, ctx);
  await emit(reversed, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(reversed.entries, [
    {
      customType: STAMP_ENTRY_TYPE,
      data: {
        version: 4,
        role: "assistant",
        timestamp: ASSISTANT_TIMESTAMP,
        metadata,
      },
    },
  ]);
});

test("thinking, completed blocks, and tool calls can be the first meaningful assistant content", async () => {
  const events = [
    { type: "thinking_delta", delta: "reasoning" },
    { type: "text_end", content: "complete" },
    { type: "toolcall_end", toolCall: { id: "call-1", name: "read", arguments: {} } },
  ] as const;
  for (const [index, assistantMessageEvent] of events.entries()) {
    const mock = createMockPi();
    const timestamp = ASSISTANT_TIMESTAMP + index * 10_000;
    let now = timestamp + 700;
    stamp(mock.pi, { settingsRuntime: testSettingsRuntime(), now: () => now });
    const { ctx } = createMockContext({ mode: "tui" });
    const assistant = assistantMessage(timestamp);
    await emit(mock, "session_start", { reason: "startup" }, ctx);
    await emit(mock, "turn_start", { turnIndex: 0, timestamp: timestamp - 10 }, ctx);
    await emit(mock, "message_start", { message: assistant }, ctx);
    await emit(mock, "message_update", { message: assistant, assistantMessageEvent }, ctx);
    now = timestamp + 2_000;
    await emit(mock, "message_end", { message: assistant }, ctx);
    now = timestamp + 20_000;
    await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
    assert.deepEqual(
      mock.entries,
      [timedAssistantStamp(timestamp, timestamp + 2_000, { firstContentAt: timestamp + 700 })],
      assistantMessageEvent.type,
    );
  }
});

test("missing first content stays unavailable and tool execution does not extend completion", async () => {
  const mock = createMockPi();
  let now = ASSISTANT_TIMESTAMP + 3_200;
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime(), now: () => now });
  const { ctx } = createMockContext({ mode: "tui" });
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP, "toolUse");
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);
  await emit(mock, "message_end", { message: assistant }, ctx);
  now = ASSISTANT_TIMESTAMP + 30_000;
  await emit(
    mock,
    "message_end",
    {
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: now,
      },
    },
    ctx,
  );
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(mock.entries, [timedAssistantStamp(ASSISTANT_TIMESTAMP, ASSISTANT_TIMESTAMP + 3_200)]);
  const renderer = createStampEntryRenderer(() => ({
    ...DEFAULT_STAMP_SETTINGS,
    responseTiming: "detailed",
  }));
  const component = renderer({ data: mock.entries[0]?.data } as never, { expanded: false }, {
    fg: (_color: string, text: string) => text,
  } as never);
  assert.ok(component);
  assert.match(component.render(80).join("\n"), /first n\/a · total 3\.2s$/u);
});

test("successive user messages flush in source order at the following message boundaries", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
  const { ctx } = createMockContext({ mode: "tui" });
  const first = userMessage(USER_TIMESTAMP);
  const second = userMessage(USER_TIMESTAMP + 1_000);
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_end", { message: first }, ctx);
  await emit(mock, "message_start", { message: second }, ctx);
  await emit(mock, "message_end", { message: second }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);

  assert.deepEqual(mock.entries, [
    stampEntry("user", USER_TIMESTAMP),
    stampEntry("user", USER_TIMESTAMP + 1_000, USER_TIMESTAMP),
  ]);
});

test("error and aborted assistant messages retain completion timing", async () => {
  for (const [index, stopReason] of ["error", "aborted"].entries()) {
    const mock = createMockPi();
    const timestamp = ASSISTANT_TIMESTAMP + index * 10_000;
    stamp(mock.pi, {
      settingsRuntime: testSettingsRuntime(),
      now: () => timestamp + 1_500,
    });
    const { ctx } = createMockContext({ mode: "tui" });
    const assistant = assistantMessage(timestamp, stopReason as "error" | "aborted");
    await emit(mock, "session_start", { reason: "startup" }, ctx);
    await emit(mock, "message_start", { message: assistant }, ctx);
    await emit(mock, "message_end", { message: assistant }, ctx);
    await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
    assert.deepEqual(mock.entries, [timedAssistantStamp(timestamp, timestamp + 1_500)]);
  }
});

test("mismatched and reversed timing degrades without leaking into a later response", async () => {
  const mock = createMockPi();
  let now = ASSISTANT_TIMESTAMP + 500;
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime(), now: () => now });
  const { ctx } = createMockContext({ mode: "tui" });
  const first = assistantMessage(ASSISTANT_TIMESTAMP);
  const mismatch = assistantMessage(ASSISTANT_TIMESTAMP + 1_000);
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: first }, ctx);
  await emit(
    mock,
    "message_update",
    { message: first, assistantMessageEvent: { type: "text_delta", delta: "x" } },
    ctx,
  );
  now = ASSISTANT_TIMESTAMP + 900;
  await emit(mock, "message_end", { message: first }, ctx);
  await emit(mock, "turn_end", { message: mismatch, toolResults: [], turnIndex: 0 }, ctx);

  const reversed = assistantMessage(ASSISTANT_TIMESTAMP + 2_000);
  await emit(mock, "turn_start", { turnIndex: 1, timestamp: ASSISTANT_TIMESTAMP + 1_500 }, ctx);
  await emit(mock, "message_start", { message: reversed }, ctx);
  now = reversed.timestamp - 1;
  await emit(mock, "message_end", { message: reversed }, ctx);
  await emit(mock, "turn_end", { message: reversed, toolResults: [], turnIndex: 1 }, ctx);

  assert.deepEqual(mock.entries, [
    stampEntry("assistant", mismatch.timestamp),
    stampEntry("assistant", reversed.timestamp, mismatch.timestamp),
  ]);
});

test("an out-of-order first-content clock is omitted while valid completion remains", async () => {
  const mock = createMockPi();
  let now = ASSISTANT_TIMESTAMP - 1;
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime(), now: () => now });
  const { ctx } = createMockContext({ mode: "tui" });
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_start", { message: assistant }, ctx);
  await emit(
    mock,
    "message_update",
    { message: assistant, assistantMessageEvent: { type: "text_delta", delta: "x" } },
    ctx,
  );
  now = ASSISTANT_TIMESTAMP + 1_000;
  await emit(mock, "message_end", { message: assistant }, ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(mock.entries, [timedAssistantStamp(ASSISTANT_TIMESTAMP, ASSISTANT_TIMESTAMP + 1_000)]);
});

test("session replacement clears finalized timing owned by the prior session", async () => {
  const mock = createMockPi();
  stamp(mock.pi, {
    settingsRuntime: testSettingsRuntime(),
    now: () => ASSISTANT_TIMESTAMP + 2_000,
  });
  const first = createMockContext({ mode: "tui" });
  const second = createMockContext({ mode: "tui" });
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);
  await emit(mock, "session_start", { reason: "startup" }, first.ctx);
  await emit(mock, "message_start", { message: assistant }, first.ctx);
  await emit(mock, "message_end", { message: assistant }, first.ctx);
  await emit(mock, "session_start", { reason: "resume" }, second.ctx);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, second.ctx);
  assert.deepEqual(mock.entries, [stampEntry("assistant", ASSISTANT_TIMESTAMP)]);
});

test("assistant tool and error turns receive one stamp without stamping tool results", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
  const { ctx } = createMockContext({ mode: "tui" });
  const toolAssistant = assistantMessage(ASSISTANT_TIMESTAMP, "toolUse");
  const errorAssistant = assistantMessage(ASSISTANT_TIMESTAMP + 2_000, "error");

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(
    mock,
    "message_end",
    {
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [],
        isError: false,
        timestamp: ASSISTANT_TIMESTAMP + 1_000,
      },
    },
    ctx,
  );
  await emit(mock, "turn_end", { message: toolAssistant, toolResults: [], turnIndex: 0 }, ctx);
  await emit(mock, "turn_end", { message: errorAssistant, toolResults: [], turnIndex: 1 }, ctx);

  assert.deepEqual(mock.entries, [
    stampEntry("assistant", ASSISTANT_TIMESTAMP),
    stampEntry("assistant", ASSISTANT_TIMESTAMP + 2_000, ASSISTANT_TIMESTAMP),
  ]);
});

test("session start rebuilds the predecessor cursor from the active branch", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
  const previous = USER_TIMESTAMP - 60_000;
  const { ctx } = createMockContext({
    mode: "tui",
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionName: () => undefined,
      getEntries: () => [],
      getBranch: () => [
        {
          type: "custom",
          customType: STAMP_ENTRY_TYPE,
          data: { version: 1, role: "user", timestamp: previous - 60_000 },
        },
        {
          type: "custom",
          customType: STAMP_ENTRY_TYPE,
          data: {
            version: 3,
            role: "assistant",
            timestamp: previous,
            completedAt: previous + 2_000,
          },
        },
      ],
    },
  });

  await emit(mock, "session_start", { reason: "resume" }, ctx);
  const assistant = assistantMessage(ASSISTANT_TIMESTAMP);
  await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
  assert.deepEqual(mock.entries, [stampEntry("assistant", ASSISTANT_TIMESTAMP, previous)]);
});

test("a delayed settings reload cannot notify through a replaced session", async () => {
  const mock = createMockPi();
  const delayed = deferred<Readonly<StampSettingsState>>();
  const activeState = defaultSettingsState();
  let reloads = 0;
  const runtime = testSettingsRuntime({
    reload: async () => {
      reloads += 1;
      return reloads === 1 ? delayed.promise : activeState;
    },
  });
  stamp(mock.pi, { settingsRuntime: runtime });
  const first = createMockContext({ mode: "tui" });
  const second = createMockContext({ mode: "tui" });

  const firstStart = emit(mock, "session_start", { reason: "startup" }, first.ctx);
  await Promise.resolve();
  await emit(mock, "session_start", { reason: "switch" }, second.ctx);
  delayed.resolve({
    ...activeState,
    issue: { kind: "invalid", message: "stale issue" },
    canSave: false,
  });
  await firstStart;

  assert.deepEqual(first.notifications, []);
  assert.deepEqual(second.notifications, []);
});

test("session shutdown waits for an in-flight settings durability boundary", async () => {
  const mock = createMockPi();
  const flushing = deferred<void>();
  const runtime = testSettingsRuntime({ flush: () => flushing.promise });
  stamp(mock.pi, { settingsRuntime: runtime });
  const { ctx } = createMockContext({ mode: "tui" });
  await emit(mock, "session_start", { reason: "startup" }, ctx);
  let settled = false;
  const shutdown = emit(mock, "session_shutdown", { reason: "quit" }, ctx).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  flushing.resolve();
  await shutdown;
  assert.equal(settled, true);
});

test("agent end and shutdown flush a pending user at most once and reload resets state", async () => {
  const mock = createMockPi();
  stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
  const { ctx } = createMockContext({ mode: "tui" });

  await emit(mock, "session_start", { reason: "startup" }, ctx);
  await emit(mock, "message_end", { message: userMessage(USER_TIMESTAMP) }, ctx);
  await emit(mock, "agent_end", { messages: [] }, ctx);
  await emit(mock, "session_shutdown", { reason: "reload" }, ctx);
  assert.deepEqual(mock.entries, [stampEntry("user", USER_TIMESTAMP)]);

  await emit(mock, "session_start", { reason: "reload" }, ctx);
  await emit(mock, "agent_end", { messages: [] }, ctx);
  assert.equal(mock.entries.length, 1);

  await emit(mock, "message_end", { message: userMessage(USER_TIMESTAMP + 1_000) }, ctx);
  await emit(mock, "session_shutdown", { reason: "quit" }, ctx);
  assert.deepEqual(mock.entries, [stampEntry("user", USER_TIMESTAMP), stampEntry("user", USER_TIMESTAMP + 1_000)]);
});

test("/stamp is argument-free, supports TUI, and rejects print and JSON observably", async () => {
  const mock = createMockPi();
  stamp(mock.pi);
  const command = mock.commands.get("stamp");
  assert.ok(command);
  const tui = createMockContext({
    mode: "tui",
    select: async (_title: string, options: string[]) => options.find((option) => option === "Close"),
  });
  await command.handler("", tui.ctx);
  await assert.rejects(async () => command.handler("extra", tui.ctx), /does not accept arguments/u);
  for (const mode of ["print", "json"] as const) {
    const { ctx } = createMockContext({ mode });
    await assert.rejects(async () => command.handler("", ctx), new RegExp(`${mode} mode`, "u"));
  }
});

test("print, JSON, and RPC sessions never append stamp entries", async () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const mock = createMockPi();
    stamp(mock.pi, { settingsRuntime: testSettingsRuntime() });
    const { ctx } = createMockContext({ mode });
    const assistant = assistantMessage(ASSISTANT_TIMESTAMP);

    await emit(mock, "session_start", { reason: "startup" }, ctx);
    await emit(mock, "message_end", { message: userMessage(USER_TIMESTAMP) }, ctx);
    await emit(mock, "message_start", { message: assistant }, ctx);
    await emit(mock, "turn_end", { message: assistant, toolResults: [], turnIndex: 0 }, ctx);
    await emit(mock, "agent_end", { messages: [] }, ctx);
    await emit(mock, "session_shutdown", { reason: "quit" }, ctx);

    assert.deepEqual(mock.entries, [], mode);
  }
});

function stampEntry(role: "user" | "assistant", timestamp: number, previousTimestamp?: number) {
  return {
    customType: STAMP_ENTRY_TYPE,
    data: {
      version: 2,
      role,
      timestamp,
      ...(previousTimestamp === undefined ? {} : { previousTimestamp }),
    },
  };
}

function timedAssistantStamp(
  timestamp: number,
  completedAt: number,
  options: { previousTimestamp?: number; firstContentAt?: number } = {},
) {
  return {
    customType: STAMP_ENTRY_TYPE,
    data: {
      version: 3,
      role: "assistant",
      timestamp,
      ...(options.previousTimestamp === undefined ? {} : { previousTimestamp: options.previousTimestamp }),
      completedAt,
      ...(options.firstContentAt === undefined ? {} : { firstContentAt: options.firstContentAt }),
    },
  };
}

function userMessage(timestamp: number) {
  return { role: "user" as const, content: "hello", timestamp };
}

function assistantMessage(timestamp: number, stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop") {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "hello" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) {
    await handler(event, ctx);
  }
}

function defaultSettingsState(): Readonly<StampSettingsState> {
  return {
    settings: { ...DEFAULT_STAMP_SETTINGS },
    sources: {
      hourCycle: "built-in",
      showSeconds: "built-in",
      dateContext: "built-in",
      locale: "built-in",
      timeZone: "built-in",
      responseTiming: "built-in",
      assistantMetadata: "built-in",
      toolStamps: "built-in",
    },
    canSave: true,
  };
}

function settingsRuntimeWith(settings: Partial<StampSettings>): StampSettingsRuntime {
  const state: Readonly<StampSettingsState> = {
    ...defaultSettingsState(),
    settings: { ...DEFAULT_STAMP_SETTINGS, ...settings },
    sources: {
      ...defaultSettingsState().sources,
      ...Object.fromEntries(Object.keys(settings).map((key) => [key, "user"])),
    },
  };
  return testSettingsRuntime({
    get: () => state,
    reload: async () => state,
    update: async () => state,
  });
}

function testSettingsRuntime(overrides: Partial<StampSettingsRuntime> = {}): StampSettingsRuntime {
  const state = defaultSettingsState();
  return {
    get: () => state,
    getPath: () => "/tmp/pi-stamp.json",
    reload: async () => state,
    update: async () => state,
    flush: async () => undefined,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

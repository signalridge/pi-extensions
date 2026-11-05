import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { registerStatuslineCommand } from "../src/commands.js";
import { loadStatuslineSettings } from "../src/settings.js";
import statusline from "../src/statusline.js";
import { FooterUsageAccumulator, summarizeFooterUsage } from "../src/usage.js";
import { createMockContext, createMockPi } from "./support.js";

function message(total: number, totalFromProvider?: boolean): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "hostile\u001b[2J\u202emodel",
    responseId: "response-1",
    timestamp: 1,
    content: [],
    stopReason: "stop",
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, totalFromProvider },
    },
  };
}

function receipt(id: string, cost: unknown): SessionEntry {
  // The unknown boundary deliberately exercises malformed/legacy persisted data.
  return { id, type: "usage", usage: { cost } } as SessionEntry;
}

test("cost provenance requires an explicit boolean and a valid total, including zero", () => {
  for (const [cost, expected] of [
    [{ total: 1, totalFromProvider: true }, "provider"],
    [{ total: 1, totalFromProvider: false }, "estimated"],
    [{ total: 0, totalFromProvider: true }, "provider"],
    [{ total: 0, totalFromProvider: false }, "estimated"],
    [{ total: 1 }, "unknown"],
    [{ total: 1, totalFromProvider: "true" }, "unknown"],
    [{ totalFromProvider: true }, "unknown"],
    [{ total: null, totalFromProvider: true }, "unknown"],
    [{ total: Number.NaN, totalFromProvider: true }, "unknown"],
    [{ total: Number.POSITIVE_INFINITY, totalFromProvider: false }, "unknown"],
    [{ total: -1, totalFromProvider: true }, "unknown"],
  ] as const) {
    const entries = [receipt("one", cost)];
    const accumulator = new FooterUsageAccumulator();
    accumulator.reset(entries);
    assert.equal(accumulator.snapshot().costOrigin ?? "unknown", expected);
    assert.deepEqual(accumulator.snapshot(), summarizeFooterUsage(entries));
  }
});

test("mixed and unconfirmed aggregates retain every contribution without changing arithmetic", () => {
  for (const other of [
    { total: 2, totalFromProvider: false },
    { total: 0 },
    { totalFromProvider: true },
    { total: Number.NaN, totalFromProvider: true },
  ]) {
    const entries = [receipt("provider", { total: 1, totalFromProvider: true }), receipt("other", other)];
    const accumulator = new FooterUsageAccumulator();
    accumulator.reset(entries.slice(0, 1));
    assert.equal(accumulator.updateUsageEntries(entries), true);
    assert.equal(accumulator.updateUsageEntries(entries), false);
    assert.equal(accumulator.snapshot().costOrigin, "mixed");
    assert.equal(accumulator.snapshot().cost, 1 + (other.total ?? 0));
    assert.deepEqual(accumulator.snapshot(), summarizeFooterUsage(entries));
    accumulator.reset([]);
    assert.equal(accumulator.snapshot().costOrigin, undefined);
  }
});

test("replacement reverses origin counts as well as tokens and totals", () => {
  const accumulator = new FooterUsageAccumulator();
  accumulator.updateMessage(message(1, true));
  accumulator.updateMessage(message(2, false));
  assert.equal(accumulator.snapshot().cost, 2);
  assert.equal(accumulator.snapshot().input, 10);
  assert.equal(accumulator.snapshot().costOrigin, "estimated");
  accumulator.updateMessage(message(0, true));
  assert.equal(accumulator.snapshot().cost, 0);
  assert.equal(accumulator.snapshot().costOrigin, "provider");
  accumulator.updateMessage(message(0));
  assert.equal(accumulator.snapshot().costOrigin ?? "unknown", "unknown");
  accumulator.updateMessage(message(3, true));
  assert.equal(accumulator.snapshot().costOrigin, "provider");
  accumulator.beginTurn();
  accumulator.updateMessage({ ...message(0, false), responseId: "response-2" });
  assert.equal(accumulator.snapshot().costOrigin, "mixed");
  accumulator.updateMessage({ ...message(0, true), responseId: "response-2" });
  assert.equal(accumulator.snapshot().costOrigin, "provider");
  assert.equal(accumulator.snapshot().cost, 3);
});

test("all historical usage-bearing kinds retain provenance through boundary rebuilds", () => {
  const entries = [
    { id: "assistant", type: "message", message: message(1, true) },
    { id: "tool", type: "message", message: { role: "toolResult", toolCallId: "t", usage: message(0, true).usage } },
    { id: "compact", type: "compaction", usage: message(2, true).usage },
    { id: "branch", type: "branch_summary", usage: message(3, true).usage },
    { id: "warm", type: "usage", usage: message(0, true).usage },
  ] as SessionEntry[];
  const accumulator = new FooterUsageAccumulator();
  accumulator.reset(entries);
  assert.equal(accumulator.snapshot().cost, 6);
  assert.equal(accumulator.snapshot().costOrigin, "provider");
  assert.deepEqual(accumulator.snapshot(), summarizeFooterUsage(entries));
  accumulator.reset([entries[3], receipt("new", { total: 0, totalFromProvider: false })]);
  assert.equal(accumulator.snapshot().cost, 3);
  assert.equal(accumulator.snapshot().costOrigin, "mixed");
  accumulator.reset([receipt("new", { total: 0, totalFromProvider: false })]);
  assert.equal(accumulator.snapshot().cost, 0);
  assert.equal(accumulator.snapshot().costOrigin, "estimated");
});

test("existing status command reports provenance without model text or model/thinking changes", async () => {
  const accumulator = new FooterUsageAccumulator();
  const mock = createMockPi();
  registerStatuslineCommand(mock.pi, {
    settingsPath: "/tmp/pi-statusline-cost-origin-missing.json",
    getLoaded: () => loadStatuslineSettings("/tmp/pi-statusline-cost-origin-missing.json"),
    getUsage: () => accumulator.snapshot(),
    apply() {
      assert.fail("status must not apply settings");
    },
  });
  const context = createMockContext({ mode: "rpc", hasUI: true });
  for (const [entries, label] of [
    [[], "unknown/legacy"],
    [[receipt("p", { total: 0, totalFromProvider: true })], "provider-reported"],
    [[receipt("e", { total: 0, totalFromProvider: false })], "estimated"],
    [[receipt("p", { total: 1, totalFromProvider: true }), receipt("u", {})], "mixed/unconfirmed"],
  ] as const) {
    accumulator.reset(entries);
    await mock.commands.get("statusline")?.handler("status", context.ctx);
    assert.ok(context.notifications.at(-1)?.message.includes(`cost origin: ${label}`));
  }
  assert.deepEqual(mock.setModels, []);
  assert.deepEqual(mock.thinkingLevels, []);
});

test("runtime status uses live replacements and rebuilds the same all-entry totals on branch/reload", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-statusline-cost-origin-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  t.onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
  });
  const session = SessionManager.inMemory();
  const ancestor = session.appendMessage({ role: "user", content: "hello", timestamp: 0 });
  session.appendMessage(message(1, true));
  const mock = createMockPi();
  statusline(mock.pi);
  const context = createMockContext({ mode: "tui", sessionManager: session });
  const emit = async (name: string, event: unknown) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, context.ctx);
  };
  const check = async (origin: string) => {
    await mock.commands.get("statusline")?.handler("status", context.ctx);
    const report = context.notifications.at(-1)?.message ?? "";
    assert.ok(report.includes(`cost origin: ${origin}`), report);
    for (const unsafe of ["hostile", "\u001b", "\u202e"]) assert.equal(report.includes(unsafe), false);
  };
  await emit("session_start", { reason: "startup" });
  await check("provider-reported");
  await emit("message_end", { message: message(2, false) });
  await check("estimated");
  // Existing accounting includes billed usage from abandoned branches via getEntries().
  session.branch(ancestor);
  session.appendMessage({ ...message(0, false), responseId: "response-2", timestamp: 2 });
  await emit("session_tree", { newLeafId: session.getLeafId() });
  await check("mixed/unconfirmed");
  await emit("session_shutdown", { reason: "reload" });
  await emit("session_start", { reason: "reload" });
  await check("mixed/unconfirmed");
  await emit("session_shutdown", { reason: "quit" });
  // Explicit headless status reports persisted history, not a retired TUI snapshot.
  const rpc = createMockContext({ mode: "rpc", hasUI: true, sessionManager: session });
  for (const handler of mock.events.get("session_start") ?? []) await handler({ reason: "resume" }, rpc.ctx);
  await mock.commands.get("statusline")?.handler("status", rpc.ctx);
  assert.ok(rpc.notifications.at(-1)?.message.includes("cost origin: mixed/unconfirmed"));
  assert.deepEqual(mock.setModels, []);
  assert.deepEqual(mock.thinkingLevels, []);
});

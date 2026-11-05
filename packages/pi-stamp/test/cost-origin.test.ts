import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CustomEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { COST_ORIGIN_ENTRY_TYPE, isCostOriginAnnotation, MAX_COST_ORIGIN_REFERENCES } from "../src/cost-origin.js";
import { DEFAULT_STAMP_SETTINGS, type StampSettings } from "../src/format.js";
import {
  captureAssistantCostOrigin,
  captureAssistantMetadata,
  formatAssistantMetadataLines,
  isAssistantMetadataData,
} from "../src/metadata.js";
import type { StampSettingsRuntime, StampSettingsState } from "../src/settings.js";
import stamp, {
  costOriginLookupFromBranch,
  createStampEntryRenderer,
  isMessageStampData,
  STAMP_ENTRY_TYPE,
} from "../src/stamp.js";
import { frozenBaseline } from "./frozen-baseline.js";
import { createMockContext, createMockPi } from "./support.js";

const assistant = {
  role: "assistant" as const,
  api: "openai-responses",
  provider: "openai",
  model: "requested-model\u001b[2J\u202etext",
  responseModel: "reported\u009b31m\nmodel",
  providerThinkingLevel: "high",
  thinkingLevel: "high" as const,
  content: [],
  stopReason: "stop" as const,
  timestamp: 1_000,
};
const settings: StampSettings = {
  ...DEFAULT_STAMP_SETTINGS,
  timeZone: "UTC",
  assistantMetadata: "expanded",
  responseTiming: "detailed",
};
const theme = { fg: (_color: string, text: string) => text } as never;

function capture(cost: unknown) {
  const metadata = captureAssistantMetadata({ ...assistant, usage: { input: 1, cost } });
  assert.ok(metadata);
  return metadata;
}

function runtime(overrides: Partial<StampSettingsRuntime> = {}): StampSettingsRuntime {
  const state: StampSettingsState = {
    settings,
    sources: Object.fromEntries(Object.keys(settings).map((key) => [key, "built-in"])) as StampSettingsState["sources"],
    canSave: true,
  };
  return {
    get: () => state,
    getPath: () => "unused-fake-settings.json",
    reload: async () => state,
    update: async () => state,
    flush: async () => undefined,
    ...overrides,
  };
}

function harness(session = SessionManager.inMemory(), settingsRuntime = runtime()) {
  const mock = createMockPi();
  mock.rawPi.appendEntry = (type, data) => {
    mock.entries.push({ customType: type, data });
    session.appendCustomEntry(type, data);
    // Deliberately returns void, as does the public ExtensionAPI.
  };
  stamp(mock.pi, { settingsRuntime, now: () => 2_000 });
  const context = createMockContext({ mode: "tui", sessionManager: session });
  const emit = async (name: string, event: unknown = {}, ctx = context.ctx) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
  };
  const entryRenderer = mock.entryRenderers.get(STAMP_ENTRY_TYPE);
  assert.ok(entryRenderer);
  const component = (entry: CustomEntry) => entryRenderer(entry, { expanded: true }, theme) as Component;
  const render = (entry: CustomEntry) =>
    component(entry)
      .render(240)
      .map((line) => line.trim())
      .join("\n");
  const turn = async (cost: unknown) => {
    const message = {
      ...assistant,
      usage: { input: 11, output: 7, reasoning: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 25, cost },
    };
    const before = JSON.stringify(message);
    await emit("turn_start");
    await emit("message_start", { message });
    await emit("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "x" } });
    await emit("message_end", { message });
    await emit("turn_end", { message, toolResults: [] });
    assert.equal(JSON.stringify(message), before);
  };
  return { mock, emit, turn, component, render, session, ctx: context.ctx };
}

function sourceEntries(session: SessionManager): CustomEntry[] {
  return session
    .getBranch()
    .filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === STAMP_ENTRY_TYPE);
}

function annotation(id: string, cost = 1, origin = "provider") {
  return { version: 1, stampEntryId: id, cost, origin };
}

function source(id = "exact-source", cost = 1) {
  return {
    type: "custom",
    customType: STAMP_ENTRY_TYPE,
    id,
    data: { version: 4, role: "assistant", timestamp: 1_000, metadata: capture({ total: cost }) },
  };
}

function sidecar(data: unknown, customType = COST_ORIGIN_ENTRY_TYPE) {
  return { type: "custom", customType, data };
}

const costs = [
  [{ total: 1.25, totalFromProvider: true }, "provider", "$1.25"],
  [{ total: 1.25, totalFromProvider: false }, "estimated", "$1.25"],
  [{ total: 0, totalFromProvider: true }, "provider", "$0"],
  [{ total: 0, totalFromProvider: false }, "estimated", "$0"],
  [{ total: 0 }, "unknown", "$0"],
  [{ total: 1.25 }, "unknown", "$1.25"],
  [{ total: 1.25, totalFromProvider: "false" }, "unknown", "$1.25"],
] as const;

test("capture keeps frozen v4 usage keys; native totals and flags are classified separately", () => {
  for (const [cost, origin, label] of costs) {
    const metadata = capture(cost);
    assert.equal(metadata.usage?.estimatedCost, cost.total);
    assert.equal(metadata.usage?.costOrigin, undefined);
    assert.equal(captureAssistantCostOrigin({ usage: { cost } }), origin);
    assert.ok(isAssistantMetadataData(metadata));
    const view = { ...metadata, usage: { ...metadata.usage, costOrigin: origin } };
    assert.equal(isAssistantMetadataData(view), false, "origin is not a v4 wire field");
    for (const mode of ["compact", "expanded"] as const) {
      const lines = formatAssistantMetadataLines(view, mode, false).join("\n");
      assert.ok(lines.includes(mode === "compact" ? `${origin} ${label}` : `${origin} cost ${label}`), lines);
      for (const control of ["\u001b", "\u009b", "\u202e"]) assert.equal(lines.includes(control), false);
    }
  }
});

test("missing or invalid totals establish no origin or cost", () => {
  for (const total of [undefined, null, "0", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    for (const totalFromProvider of [true, false]) {
      const cost = { total, totalFromProvider };
      assert.deepEqual(capture(cost).usage, { input: 1 });
      assert.equal(captureAssistantCostOrigin({ usage: { cost } }), undefined);
    }
  }
});

test("newly emitted v4 entries execute frozen 0d reader/renderer, live overlay and reopen without history mutation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stamp-v4-rollback-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const h = harness(SessionManager.create(directory, directory));
  h.session.appendMessage({ role: "user", content: "hello", timestamp: 0 });
  h.session.appendMessage({
    ...assistant,
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  await h.emit("session_start");
  const baseline = frozenBaseline();
  const oldRenderer = baseline.createStampEntryRenderer(() => settings);
  const sourceIds: string[] = [];
  for (const [index, [cost, origin, label]] of costs.entries()) {
    await h.turn(cost);
    const entry = sourceEntries(h.session).at(-1);
    assert.ok(entry && isMessageStampData(entry.data) && entry.data.version === 4);
    sourceIds.push(entry.id);
    const data = entry.data;
    assert.equal(data.timestamp, 1_000, "duplicate timestamps intentionally remain identical");
    assert.equal(data.previousTimestamp, index === 0 ? undefined : 1_000);
    assert.equal(data.completedAt, 2_000);
    assert.equal(data.firstContentAt, 2_000);
    assert.deepEqual(data.metadata.usage, {
      input: 11,
      output: 7,
      reasoning: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 25,
      estimatedCost: cost.total,
    });
    assert.ok(baseline.isMessageStampData(data), "rollback must accept NEW writer output");
    assert.equal(
      baseline.isMessageStampData({
        ...data,
        metadata: { ...data.metadata, usage: { ...data.metadata.usage, costOrigin: origin } },
      }),
      false,
      "the frozen reader must expose the original unknown-field regression",
    );
    const old = oldRenderer(entry as never, { expanded: true } as never, theme);
    assert.ok(old);
    const oldText = old.render(240).join("\n");
    assert.match(oldText, /00:00:01 · first 1.0s · total 1.0s/u);
    assert.match(oldText, /api openai-responses · provider openai · requested requested-model/u);
    assert.match(oldText, /tokens in 11 · out 7 · reasoning 2 · cache read 3 · cache write 4 · total 25/u);
    assert.ok(oldText.includes(`est cost ${label}`));
    const stored = JSON.stringify(h.session.getEntries());
    assert.ok(h.render(entry).includes(`${origin} cost ${label}`));
    const generic = createStampEntryRenderer(() => settings)(entry as never, { expanded: false } as never, theme);
    assert.match(generic?.render(240).join("\n") ?? "", /unknown cost/u, "no sidecar lookup means unknown");
    const last = h.session.getBranch().at(-1);
    assert.ok(last?.type === "custom" && last.customType === COST_ORIGIN_ENTRY_TYPE);
    assert.deepEqual(last.data, annotation(entry.id, cost.total, origin));
    assert.equal(oldRenderer(last as never, { expanded: true } as never, theme), undefined);
    assert.equal(JSON.stringify(h.session.getEntries()), stored);
  }
  assert.equal(new Set(sourceIds).size, costs.length, "association uses exact IDs, never timestamps");
  const file = h.session.getSessionFile();
  assert.ok(file);
  const bytes = readFileSync(file, "utf8");
  const reopened = harness(SessionManager.open(file, directory));
  await reopened.emit("session_start");
  for (const [index, entry] of sourceEntries(reopened.session).entries()) {
    assert.ok(reopened.render(entry).includes(`${costs[index][1]} cost ${costs[index][2]}`));
    const component = reopened.component(entry);
    for (const width of [1, 8, 20]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
    }
  }
  assert.equal(readFileSync(file, "utf8"), bytes);
  assert.deepEqual(
    reopened.session.buildSessionContext().messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.deepEqual(h.mock.setModels, []);
  assert.deepEqual(h.mock.thinkingLevels, []);
  assert.deepEqual(h.mock.providerRegistrations, []);
  await h.emit("session_shutdown");
  await reopened.emit("session_shutdown");
});

test("a live component mounted synchronously during source append receives only the later view overlay", async () => {
  const h = harness();
  await h.emit("session_start");
  const append = h.mock.rawPi.appendEntry;
  let mounted: Component | undefined;
  h.mock.rawPi.appendEntry = (type, data) => {
    append(type, data);
    if (type !== STAMP_ENTRY_TYPE) return;
    const entry = sourceEntries(h.session).at(-1);
    assert.ok(entry);
    mounted = h.component(entry);
    assert.match(mounted.render(240).join("\n"), /unknown cost/u);
    assert.ok(isMessageStampData(data) && data.version === 4);
    Object.freeze(data.metadata.usage);
    Object.freeze(data.metadata);
    Object.freeze(data);
  };
  await h.turn({ total: 0, totalFromProvider: true });
  assert.ok(mounted);
  assert.match(mounted.render(240).join("\n"), /provider cost \$0/u);
  const entry = sourceEntries(h.session)[0];
  assert.ok(isMessageStampData(entry.data) && entry.data.version === 4);
  assert.equal(entry.data.metadata.usage?.costOrigin, undefined);
});

test("lookup is branch-local: tree navigation removes and restores exact-reference annotations", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.turn({ total: 0, totalFromProvider: true });
  const first = sourceEntries(h.session)[0];
  const annotatedLeaf = h.session.getLeafId();
  assert.ok(annotatedLeaf);
  const mounted = h.component(first);
  assert.match(mounted.render(240).join("\n"), /provider cost \$0/u);
  h.session.branch(first.id);
  await h.emit("session_tree");
  assert.match(h.render(first), /unknown cost \$0/u);
  assert.match(mounted.render(240).join("\n"), /unknown cost \$0/u, "old mounted generation retired");
  await h.turn({ total: 0, totalFromProvider: false });
  const second = sourceEntries(h.session).at(-1);
  assert.ok(second && second.id !== first.id);
  assert.match(h.render(first), /unknown cost \$0/u);
  assert.match(h.render(second), /estimated cost \$0/u);
  h.session.branch(annotatedLeaf);
  await h.emit("session_tree");
  assert.match(h.render(first), /provider cost \$0/u);
  assert.match(h.render(second), /unknown cost \$0/u, "abandoned sibling cannot borrow equal timestamp/cost");
  const active = h.component(first);
  await h.emit("session_shutdown");
  assert.match(active.render(240).join("\n"), /unknown cost \$0/u);
});

test("unknown, malformed, mismatched, early, duplicate and oversized annotations never invent billing proof", () => {
  const target = source();
  const good = annotation(target.id);
  const invalid = [
    null,
    {},
    { ...good, version: 2 },
    { ...good, origin: "mixed" },
    { ...good, origin: true },
    { ...good, cost: -1 },
    { ...good, cost: Number.NaN },
    { ...good, cost: Number.POSITIVE_INFINITY },
    { ...good, cost: "1" },
    { ...good, extra: true },
    { ...good, stampEntryId: "x".repeat(161) },
    { ...good, stampEntryId: "bad\u001b-id" },
  ];
  assert.ok(isCostOriginAnnotation(good));
  assert.equal(costOriginLookupFromBranch([target, sidecar(good)])(target.id, 2), undefined);
  for (const data of invalid) {
    assert.equal(isCostOriginAnnotation(data), false);
    assert.equal(costOriginLookupFromBranch([target, sidecar(data)])(target.id, 1), undefined);
  }
  for (const entries of [
    [target],
    [sidecar(good), target],
    [target, sidecar(good, "pi-stamp:cost-origin:v2")],
    [target, sidecar(annotation("not-this-id"))],
    [target, sidecar(annotation(target.id, 2))],
    [target, sidecar(good), sidecar(good)],
    [target, sidecar(good), sidecar({ ...good, version: 2 })],
    [target, sidecar({ ...good, origin: "invalid" }), sidecar(good)],
    [target, sidecar(good), source(target.id)],
  ])
    assert.equal(costOriginLookupFromBranch(entries)(target.id, 1), undefined);
  const bounded = Array.from({ length: MAX_COST_ORIGIN_REFERENCES + 1 }, (_, index) => source(`source-${index}`));
  assert.equal(costOriginLookupFromBranch([target, sidecar(good), ...bounded])(target.id, 1), undefined);
  const manyAnnotations = Array.from({ length: MAX_COST_ORIGIN_REFERENCES + 1 }, (_, index) =>
    sidecar(annotation(`missing-${index}`)),
  );
  assert.equal(costOriginLookupFromBranch([target, sidecar(good), ...manyAnnotations])(target.id, 1), undefined);
});

test("mounted and fresh renderers invalidate attribution after duplicate or malformed branch appends", async () => {
  for (const malformed of [false, true]) {
    const h = harness();
    await h.emit("session_start");
    await h.turn({ total: 0, totalFromProvider: true });
    const entry = sourceEntries(h.session)[0];
    const mounted = h.component(entry);
    assert.match(mounted.render(240).join("\n"), /provider cost \$0/u);
    const getBranch = h.session.getBranch.bind(h.session);
    let reads = 0;
    h.session.getBranch = (...args) => {
      reads++;
      return getBranch(...args);
    };
    for (let index = 0; index < 20; index++) mounted.render(240);
    assert.equal(reads, 0, "an unchanged leaf reuses its qualified snapshot");
    const data = annotation(entry.id, 0);
    h.session.appendCustomEntry(COST_ORIGIN_ENTRY_TYPE, malformed ? { ...data, version: 2 } : data);
    const before = JSON.stringify(h.session.getEntries());
    assert.equal(costOriginLookupFromBranch(h.session.getBranch())(entry.id, 0), undefined);
    reads = 0;
    assert.match(mounted.render(240).join("\n"), /unknown cost \$0/u);
    assert.match(h.render(entry), /unknown cost \$0/u);
    assert.equal(reads, 1, "the changed leaf is requalified once, including fresh renderers");
    assert.equal(JSON.stringify(h.session.getEntries()), before);
    await h.emit("session_shutdown");
  }
});

test("source overflow invalidates cached attribution even when the optional annotation write fails", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.turn({ total: 0, totalFromProvider: true });
  const first = sourceEntries(h.session)[0];
  const mounted = h.component(first);
  for (let index = 1; index < MAX_COST_ORIGIN_REFERENCES; index++) {
    h.session.appendCustomEntry(STAMP_ENTRY_TYPE, source(`overflow-${index}`).data);
  }
  assert.match(mounted.render(240).join("\n"), /provider cost \$0/u);
  const append = h.mock.rawPi.appendEntry;
  h.mock.rawPi.appendEntry = (type, data) => {
    if (type === COST_ORIGIN_ENTRY_TYPE) throw new Error("optional write failed");
    append(type, data);
  };
  await h.turn({ total: 1, totalFromProvider: false });
  const last = sourceEntries(h.session).at(-1);
  assert.ok(last && isMessageStampData(last.data) && last.data.version === 4);
  assert.equal(last.data.previousTimestamp, 1_000);
  assert.equal(last.data.metadata.usage?.estimatedCost, 1);
  assert.equal(costOriginLookupFromBranch(h.session.getBranch())(first.id, 0), undefined);
  const before = JSON.stringify(h.session.getEntries());
  assert.match(mounted.render(240).join("\n"), /unknown cost \$0/u);
  assert.match(h.render(first), /unknown cost \$0/u);
  assert.equal(JSON.stringify(h.session.getEntries()), before);
  await h.emit("session_shutdown");
});

test("an invalid optional view lookup cannot hide valid v4 metadata or mutate history", () => {
  const entry = source();
  const before = JSON.stringify(entry);
  const renderer = createStampEntryRenderer(
    () => settings,
    () => "invalid-origin" as never,
  );
  const component = renderer(entry as never, { expanded: false } as never, theme);
  assert.ok(component);
  assert.match(component.render(240).join("\n"), /unknown cost \$1/u);
  assert.equal(JSON.stringify(entry), before);
});

test("optional annotation write failure preserves source timing, predecessor ordering and unknown view", async () => {
  const h = harness();
  const append = h.mock.rawPi.appendEntry;
  h.mock.rawPi.appendEntry = (type, data) => {
    if (type === COST_ORIGIN_ENTRY_TYPE) throw new Error("optional write failed");
    append(type, data);
  };
  await h.emit("session_start");
  await h.turn({ total: 0, totalFromProvider: true });
  await h.turn({ total: 1, totalFromProvider: false });
  const entries = sourceEntries(h.session);
  assert.equal(entries.length, 2);
  assert.ok(isMessageStampData(entries[1].data) && entries[1].data.version === 4);
  assert.equal(entries[1].data.previousTimestamp, 1_000);
  assert.equal(entries[1].data.completedAt, 2_000);
  assert.match(h.render(entries[0]), /unknown cost \$0/u);
  assert.match(h.render(entries[1]), /unknown cost \$1/u);
});

test("optional annotation failure cannot suppress the final source-ordered tool stamp", async () => {
  const base = runtime();
  const state = { ...base.get(), settings: { ...settings, toolStamps: true } };
  const h = harness(undefined, runtime({ get: () => state, reload: async () => state }));
  const append = h.mock.rawPi.appendEntry;
  h.mock.rawPi.appendEntry = (type, data) => {
    if (type === COST_ORIGIN_ENTRY_TYPE) throw new Error("optional write failed");
    append(type, data);
  };
  await h.emit("session_start");
  await h.emit("tool_execution_start", { toolCallId: "tool-1", toolName: "read" });
  await h.emit("tool_execution_end", { toolCallId: "tool-1" });
  await h.emit("turn_end", {
    message: { ...assistant, usage: { cost: { total: 0, totalFromProvider: true } } },
    toolResults: [{ toolCallId: "tool-1", isError: false }],
  });
  assert.equal(h.mock.entries.length, 2);
  assert.ok(isMessageStampData(h.mock.entries[0].data));
  assert.deepEqual(h.mock.entries[1], {
    customType: STAMP_ENTRY_TYPE,
    data: {
      version: 1,
      kind: "tool",
      toolCallId: "tool-1",
      toolName: "read",
      startedAt: 2_000,
      completedAt: 2_000,
      outcome: "success",
    },
  });
});

test("source write failure remains a failure and does not advance predecessor or append annotation", async () => {
  const h = harness();
  await h.emit("session_start");
  const append = h.mock.rawPi.appendEntry;
  h.mock.rawPi.appendEntry = () => {
    throw new Error("source failed");
  };
  await assert.rejects(h.turn({ total: 1, totalFromProvider: true }), /source failed/u);
  assert.deepEqual(h.session.getEntries(), []);
  h.mock.rawPi.appendEntry = append;
  await h.turn({ total: 1, totalFromProvider: true });
  const entry = sourceEntries(h.session)[0];
  assert.ok(isMessageStampData(entry.data) && entry.data.version === 4);
  assert.equal(entry.data.previousTimestamp, undefined);
});

test("cannot prove exact new native child: no append return, stale leaf, intervening append and branch changes skip annotation", async () => {
  for (const fault of ["noop", "extra", "branch", "leaf", "cancel"] as const) {
    const h = harness();
    const root = h.session.appendCustomEntry("test-root", {});
    await h.emit("session_start");
    const append = h.mock.rawPi.appendEntry;
    const controller = new AbortController();
    const ctx = createMockContext({ mode: "tui", sessionManager: h.session, signal: controller.signal }).ctx;
    h.mock.rawPi.appendEntry = (type, data) => {
      if (fault === "noop") return;
      append(type, data);
      if (fault === "extra") h.session.appendCustomEntry("other", {});
      if (fault === "branch") h.session.branch(root);
      if (fault === "cancel") controller.abort();
    };
    if (fault === "leaf") h.session.getLeafId = () => "not-the-native-leaf";
    await h.emit(
      "turn_end",
      { message: { ...assistant, usage: { cost: { total: 0, totalFromProvider: true } } }, toolResults: [] },
      ctx,
    );
    assert.equal(
      h.mock.entries.some((entry) => entry.customType === COST_ORIGIN_ENTRY_TYPE),
      false,
      fault,
    );
  }
});

test("tree/shutdown/replacement during source append cancels annotation generation; cancelled tree preserves lookup", async () => {
  for (const terminal of ["session_tree", "session_shutdown", "session_start"] as const) {
    const h = harness();
    await h.emit("session_start");
    await h.turn({ total: 0, totalFromProvider: true });
    const first = sourceEntries(h.session)[0];
    const mounted = h.component(first);
    await h.emit("session_before_tree"); // Cancelled navigation emits no session_tree.
    assert.match(mounted.render(240).join("\n"), /provider cost/u);
    const append = h.mock.rawPi.appendEntry;
    let retirement: Promise<void> | undefined;
    h.mock.rawPi.appendEntry = (type, data) => {
      append(type, data);
      if (type === STAMP_ENTRY_TYPE) retirement = h.emit(terminal);
    };
    await h.turn({ total: 1, totalFromProvider: false });
    await retirement;
    assert.equal(h.mock.entries.filter((entry) => entry.customType === COST_ORIGIN_ENTRY_TYPE).length, 1, terminal);
    assert.match(mounted.render(240).join("\n"), /unknown cost/u);
  }
});

test("replacement clears old lookup immediately, including a delayed settings reload", async () => {
  let finish: (() => void) | undefined;
  let delayed = false;
  const base = runtime();
  const h = harness(
    undefined,
    runtime({
      reload: async () => {
        if (delayed)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return base.get();
      },
    }),
  );
  await h.emit("session_start");
  await h.turn({ total: 0, totalFromProvider: true });
  const entry = sourceEntries(h.session)[0];
  const mounted = h.component(entry);
  delayed = true;
  const replacement = createMockContext({ mode: "tui", sessionManager: SessionManager.inMemory() });
  const starting = h.emit("session_start", {}, replacement.ctx);
  assert.match(mounted.render(240).join("\n"), /unknown cost/u);
  assert.match(h.render(entry), /unknown cost/u);
  assert.ok(finish);
  finish();
  await starting;
});

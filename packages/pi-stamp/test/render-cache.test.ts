import assert from "node:assert/strict";
import { Theme } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import * as format from "../src/format.js";
import { formatAssistantMetadataLines } from "../src/metadata.js";
import {
  MAX_STAMP_RENDER_CACHE_BYTES,
  MAX_STAMP_RENDER_CACHE_ENTRIES,
  MAX_STAMP_RENDER_VALUE_BYTES,
  StampRenderCache,
  stampRenderSnapshot,
} from "../src/render-cache.js";
import { createStampEntryRenderer, type StampEntryData } from "../src/stamp.js";

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof tui>();
  return { ...actual, wrapTextWithAnsi: vi.fn(actual.wrapTextWithAnsi) };
});

const timestamp = Date.UTC(2026, 6, 30, 0, 1, 2);
const identityTheme = { fg: (_color: string, text: string) => text } as never;
function fixture() {
  const settings = { ...format.DEFAULT_STAMP_SETTINGS, timeZone: "UTC", assistantMetadata: "expanded" };
  const data = {
    version: 4 as const,
    role: "assistant" as const,
    timestamp,
    previousTimestamp: timestamp - 86_400_000,
    completedAt: timestamp + 3_200,
    firstContentAt: timestamp + 800,
    metadata: {
      api: "api",
      provider: "provider",
      model: "requested",
      responseModel: "response",
      responseId: "response-id",
      stopReason: "stop" as const,
      usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 15, estimatedCost: 1 },
      diagnosticCount: 1,
      diagnostics: [{ type: "retry", errorName: "HTTPError", errorCode: "429" }],
    },
  };
  const entry = { id: "exact-id", data };
  const options = { expanded: false };
  const renderer = createStampEntryRenderer(() => settings as format.StampSettings);
  const component = renderer(entry, options, identityTheme);
  assert.ok(component);
  return { settings, data, entry, options, renderer, component };
}

test("unchanged renders reuse uncoloured label, metadata and wrapping; same-object foreground stays live", () => {
  const label = vi.spyOn(format, "formatMessageStampLabel");
  const parts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
  const wrap = vi.mocked(tui.wrapTextWithAnsi).mockClear();
  const f = fixture();
  let color = 31;
  const theme = { fg: (_token: string, text: string) => `\u001b[${color}m${text}\u001b[39m` };
  const component = f.renderer(f.entry, f.options, theme as never);
  assert.ok(component);
  const first = component.render(50);
  const warmed = { label: label.mock.calls.length, parts: parts.mock.calls.length, wrap: wrap.mock.calls.length };
  for (let frame = 0; frame < 50; frame++) assert.deepEqual(component.render(50), first);
  color = 32;
  const recolored = component.render(50);
  assert.notDeepEqual(recolored, first);
  assert.deepEqual(recolored.map(tui.stripTerminalSequences), first.map(tui.stripTerminalSequences));
  assert.equal(label.mock.calls.length, warmed.label);
  assert.equal(parts.mock.calls.length, warmed.parts);
  assert.ok(wrap.mock.calls.length > warmed.wrap, "changed foreground codes requalify ANSI wrapping");
  const recoloredWraps = wrap.mock.calls.length;
  assert.deepEqual(component.render(50), recolored);
  assert.equal(wrap.mock.calls.length, recoloredWraps);
  component.render(12);
  assert.equal(label.mock.calls.length, warmed.label, "width changes only layout");
  assert.ok(wrap.mock.calls.length > warmed.wrap);
  for (const line of component.render(12)) assert.ok(tui.visibleWidth(line) <= 12);
  const beforeInvalidate = label.mock.calls.length;
  component.invalidate();
  component.render(12);
  assert.equal(label.mock.calls.length, beforeInvalidate + 1, "public invalidation clears all cached work");
});

test("uncoloured row reuse preserves public SDK coloured wrapping, including narrow whitespace-only rows", () => {
  const f = fixture();
  const theme = new Theme(
    { dim: "#777777", muted: "#888888", text: "#eeeeee", thinkingXhigh: "#cccccc" } as never,
    { selectedBg: "#222222" } as never,
    "truecolor",
  );
  const component = f.renderer(f.entry, f.options, theme);
  assert.ok(component);
  const label = format.formatMessageStampLabel(f.data, f.settings as format.StampSettings);
  assert.ok(label);
  const lines = [label, ...formatAssistantMetadataLines(f.data.metadata, "expanded", false)];
  for (const width of [1, 2, 4, 8, 20, 80, 120]) {
    const expected = lines
      .flatMap((line) => tui.wrapTextWithAnsi(theme.fg("dim", line), width))
      .map((line) => `${" ".repeat(Math.max(0, width - tui.visibleWidth(line)))}${line}`);
    const actual = component.render(width);
    assert.deepEqual(actual.map(tui.stripTerminalSequences), expected.map(tui.stripTerminalSequences));
    assert.deepEqual(component.render(width), actual);
    for (const line of actual) assert.ok(tui.visibleWidth(line) <= width);
    assert.ok(actual.every((line) => !line.includes("\u0000")));
  }
});

test("all settings values, expansion, entry replacement and deep field mutations invalidate on the same objects", () => {
  const f = fixture();
  const label = vi.spyOn(format, "formatMessageStampLabel");
  const check = (mutate: () => void) => {
    f.component.render(80);
    const calls = label.mock.calls.length;
    mutate();
    const actual = f.component.render(80);
    assert.equal(label.mock.calls.length, calls + 1);
    const fresh = f.renderer(f.entry, f.options, identityTheme);
    assert.ok(fresh);
    assert.deepEqual(actual, fresh.render(80));
  };
  for (const patch of [
    { hourCycle: "12h" },
    { showSeconds: false },
    { dateContext: "never" },
    { locale: "fr-FR" },
    { timeZone: "Pacific/Honolulu" },
    { responseTiming: "detailed" },
    { assistantMetadata: "compact" },
    { toolStamps: true },
  ])
    check(() => Object.assign(f.settings, patch));
  check(() => {
    f.options.expanded = true;
  });
  check(() => {
    f.data.timestamp += 100;
  });
  check(() => {
    f.data.previousTimestamp = f.data.timestamp;
  });
  check(() => {
    f.data.completedAt += 1_000;
  });
  check(() => {
    f.data.firstContentAt += 1;
  });
  for (const field of ["api", "provider", "model", "responseModel", "responseId"] as const) {
    check(() => {
      f.data.metadata[field] += "-changed";
    });
  }
  check(() => {
    Object.assign(f.data.metadata, { stopReason: "length" });
  });
  for (const field of [
    "input",
    "output",
    "reasoning",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "estimatedCost",
  ] as const) {
    check(() => {
      f.data.metadata.usage[field] += 1;
    });
  }
  check(() => {
    f.data.metadata.diagnosticCount += 1;
  });
  for (const field of ["type", "errorName", "errorCode"] as const) {
    check(() => {
      f.data.metadata.diagnostics[0][field] += "-changed";
    });
  }
  check(() => {
    f.data.metadata.diagnostics.push({ type: "extra", errorName: "Error", errorCode: "500" });
  });
  check(() => {
    f.entry.id = "different-exact-id";
  });
  check(() => {
    f.entry.data = { ...f.data, timestamp: f.data.timestamp + 100 };
  });
});

test("schema-invalid in-place mutations cannot select a previously valid label; recovery revalidates", () => {
  const f = fixture();
  assert.ok(f.component.render(80).length > 0);
  Object.assign(f.data.metadata.usage, { costOrigin: "provider" });
  assert.deepEqual(f.component.render(80), [], "frozen v4 does not accept a view-only origin");
  Reflect.deleteProperty(f.data.metadata.usage, "costOrigin");
  assert.ok(f.component.render(80).length > 0);
  Object.assign(f.data, { future: true });
  assert.deepEqual(f.component.render(80), []);
  Reflect.deleteProperty(f.data, "future");
  assert.ok(f.component.render(80).length > 0);
  Reflect.deleteProperty(f.data.metadata, "provider");
  assert.deepEqual(f.component.render(80), []);
  f.data.metadata.provider = "restored";
  assert.match(f.component.render(200).join("\n"), /provider restored/u);
  f.options.expanded = true;
  Object.defineProperty(f.data.metadata, "responseId", { value: "hidden-own", writable: true, enumerable: false });
  assert.match(f.component.render(200).join("\n"), /response id hidden-own/u);
  f.data.metadata.responseId = "mutated-hidden-own";
  assert.match(f.component.render(200).join("\n"), /response id mutated-hidden-own/u);
  Reflect.deleteProperty(f.data.metadata, "provider");
  const inherited = { provider: "inherited" };
  Object.setPrototypeOf(f.data.metadata, inherited);
  assert.match(f.component.render(200).join("\n"), /provider inherited/u);
  inherited.provider = "changed-inherited";
  assert.match(f.component.render(200).join("\n"), /provider changed-inherited/u);
});

test("descriptor enumerability changes revalidate provider metadata and formerly hidden unknown fields", () => {
  const f = fixture();
  const lookup = vi.fn(() => "provider" as const);
  const renderer = createStampEntryRenderer(() => f.settings as format.StampSettings, lookup);
  const component = renderer(f.entry, f.options, identityTheme);
  assert.ok(component);
  assert.match(component.render(200).join("\n"), /provider cost \$1/u);
  Object.defineProperty(f.data.metadata, "api", { enumerable: false });
  const fresh = renderer(f.entry, f.options, identityTheme);
  assert.ok(fresh);
  assert.equal(fresh.render(200).length, 1, "metadata spread omits the required hidden API");
  assert.deepEqual(component.render(200), fresh.render(200));
  Object.defineProperty(f.data.metadata, "api", { enumerable: true });
  assert.match(component.render(200).join("\n"), /provider cost \$1/u);
  Object.defineProperty(f.data.metadata, "future", { value: true, enumerable: false, configurable: true });
  assert.match(component.render(200).join("\n"), /provider cost \$1/u);
  Object.defineProperty(f.data.metadata, "future", { enumerable: true });
  assert.deepEqual(component.render(200), [], "enumerable unknown fields must reach the frozen validator");
  Reflect.deleteProperty(f.data.metadata, "future");
  assert.match(component.render(200).join("\n"), /provider cost \$1/u);
  assert.equal(lookup.mock.calls.length, 8, "provenance stays live before cache selection");
});

test("snapshots bypass accessor data without invoking getters or retaining a previous value", () => {
  const cache = new StampRenderCache();
  const key = Symbol();
  const getter = vi.fn(() => "api");
  const data = { api: "api" };
  const lines = vi.fn(() => [data.api]);
  cache.lines(key, stampRenderSnapshot(data, []), lines);
  Object.defineProperty(data, "api", { get: getter });
  const snapshot = stampRenderSnapshot(data, []);
  assert.equal(snapshot, undefined);
  assert.equal(getter.mock.calls.length, 0, "snapshot inspection must not add accessor side effects");
  cache.lines(key, snapshot, lines);
  cache.lines(key, stampRenderSnapshot(data, []), lines);
  assert.equal(lines.mock.calls.length, 3);
  assert.equal(getter.mock.calls.length, 2, "only ordinary formatting reads the accessor");
});

test("live attribution is consulted before every hit and changes cannot borrow a cached known label", () => {
  const f = fixture();
  let origin: "provider" | "estimated" | undefined = "provider";
  const lookup = vi.fn(() => origin);
  const renderer = createStampEntryRenderer(() => f.settings as format.StampSettings, lookup);
  const component = renderer(f.entry, f.options, identityTheme);
  assert.ok(component);
  for (let i = 0; i < 20; i++) assert.match(component.render(200).join("\n"), /provider cost \$1/u);
  assert.equal(lookup.mock.calls.length, 20);
  origin = undefined;
  assert.match(component.render(200).join("\n"), /unknown cost \$1/u);
  origin = "estimated";
  assert.match(component.render(200).join("\n"), /estimated cost \$1/u);
  f.data.metadata.usage.estimatedCost = 2;
  component.render(200);
  assert.deepEqual(lookup.mock.lastCall, ["exact-id", 2]);
});

test("tool data and disabled state are value-sensitive, including same-object outcome/name/duration changes", () => {
  const settings = { ...format.DEFAULT_STAMP_SETTINGS, toolStamps: true };
  const data: StampEntryData = {
    version: 1,
    kind: "tool",
    toolCallId: "call",
    toolName: "read",
    startedAt: timestamp,
    completedAt: timestamp + 100,
    outcome: "success",
  };
  const entry = { id: "tool", data };
  const renderer = createStampEntryRenderer(() => settings);
  const component = renderer(entry, { expanded: false }, identityTheme);
  assert.ok(component);
  assert.match(component.render(80).join("\n"), /tool read · 0.1s · success/u);
  Object.assign(data, { toolName: "write", outcome: "error", completedAt: timestamp + 1_000 });
  assert.match(component.render(80).join("\n"), /tool write · 1.0s · error/u);
  settings.toolStamps = false;
  assert.deepEqual(component.render(80), []);
  settings.toolStamps = true;
  assert.match(component.render(80).join("\n"), /write/u);
  Object.assign(data, { toolCallId: "" });
  assert.deepEqual(component.render(80), []);
});

test("mounted labels preserve process-environment changes, the 60s OS probe and selected-zone day boundaries", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  const Original = Intl.DateTimeFormat;
  let locale = "en-US";
  let timeZone = "UTC";
  let fail = false;
  const probe = vi.fn();
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function Formatter(locales, options) {
    if (locales === undefined && options === undefined) {
      probe();
      if (fail) throw new Error("OS unavailable");
      const formatter = new Original();
      vi.spyOn(formatter, "resolvedOptions").mockReturnValue({ ...formatter.resolvedOptions(), locale, timeZone });
      return formatter;
    }
    return new Original(locales, options);
  } as typeof Intl.DateTimeFormat);
  const previous = process.env.LC_TIME;
  try {
    process.env.LC_TIME = "render-cache-epoch-1";
    const f = fixture();
    Object.assign(f.settings, { locale: "system", timeZone: "local", assistantMetadata: "off" });
    f.data.previousTimestamp = timestamp - 60_000 * 2;
    const initial = f.component.render(100).join("\n");
    assert.match(initial, /2026.*00:01:02/u);
    assert.equal(probe.mock.calls.length, 1);
    locale = "fr-FR";
    timeZone = "Pacific/Honolulu";
    vi.advanceTimersByTime(59_999);
    assert.equal(f.component.render(100).join("\n"), initial);
    assert.equal(probe.mock.calls.length, 1);
    vi.advanceTimersByTime(1);
    const changed = f.component.render(100).join("\n");
    assert.match(changed, /14:01:02/u);
    assert.doesNotMatch(changed, /2026/u, "both timestamps are on the same selected-zone day");
    assert.equal(probe.mock.calls.length, 2);
    timeZone = "UTC";
    process.env.LC_TIME = "render-cache-epoch-2";
    assert.match(f.component.render(100).join("\n"), /2026.*00:01:02/u);
    fail = true;
    process.env.LC_TIME = "render-cache-epoch-3";
    assert.deepEqual(f.component.render(100), []);
    fail = false;
    assert.ok(f.component.render(100).length > 0);
    Object.assign(f.settings, { timeZone: "Asia/Taipei", locale: "invariant" });
    assert.equal(f.component.render(100).join("\n").trim(), "08:01:02");
  } finally {
    if (previous === undefined) delete process.env.LC_TIME;
    else process.env.LC_TIME = previous;
  }
});

test("failed label formatting across the OS probe TTL is retried even when recovery keeps the same epoch", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
  const Original = Intl.DateTimeFormat;
  const probe = vi.fn();
  let fail = false;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function Formatter(locales, options) {
    if (locales === undefined && options === undefined) {
      probe();
      if (fail) throw new Error("OS unavailable at TTL boundary");
      const formatter = new Original();
      vi.spyOn(formatter, "resolvedOptions").mockReturnValue({
        ...formatter.resolvedOptions(),
        locale: "en-US",
        timeZone: "UTC",
      });
      return formatter;
    }
    return new Original(locales, options);
  } as typeof Intl.DateTimeFormat);
  const previous = process.env.LC_TIME;
  try {
    process.env.LC_TIME = "render-cache-ttl-boundary";
    const f = fixture();
    Object.assign(f.settings, { timeZone: "local", assistantMetadata: "off" });
    const epoch = format.stampFormatEnvironmentEpoch(f.settings as format.StampSettings);
    assert.equal(probe.mock.calls.length, 1);
    vi.advanceTimersByTime(59_999);
    const originalLabel = format.formatMessageStampLabel;
    const label = vi.spyOn(format, "formatMessageStampLabel").mockImplementationOnce((...args) => {
      vi.advanceTimersByTime(1);
      return originalLabel(...args);
    });
    fail = true;
    assert.deepEqual(f.component.render(100), []);
    assert.equal(probe.mock.calls.length, 2, "epoch check precedes expiry but formatting crosses it");
    fail = false;
    const recovered = f.component.render(100);
    assert.ok(recovered.length > 0, "a formatting failure must not become a successful empty cache value");
    assert.equal(probe.mock.calls.length, 3);
    assert.equal(format.stampFormatEnvironmentEpoch(f.settings as format.StampSettings), epoch);
    assert.deepEqual(f.component.render(100), recovered);
    assert.equal(label.mock.calls.length, 2, "successful recovery is cached normally");
    assert.equal(probe.mock.calls.length, 3, "recovery does not weaken the 60s probe TTL");
  } finally {
    if (previous === undefined) delete process.env.LC_TIME;
    else process.env.LC_TIME = previous;
  }
});

test("cache count, payload bytes, width replacement, invalidation and retirement have hard bounds", () => {
  const cache = new StampRenderCache();
  const first = Symbol("first");
  const formatLines = vi.fn(() => ["first"]);
  const snapshot = [1];
  cache.lines(first, snapshot, formatLines);
  for (let i = 0; i < MAX_STAMP_RENDER_CACHE_ENTRIES; i++) cache.lines(Symbol(), [i], () => ["small"]);
  cache.lines(first, snapshot, formatLines);
  assert.equal(formatLines.mock.calls.length, 2, "count LRU evicts oldest");
  cache.clear();
  cache.lines(first, snapshot, formatLines);
  const payload = "x".repeat(4_096);
  for (let i = 0; i < MAX_STAMP_RENDER_CACHE_BYTES / (payload.length * 2); i++) {
    cache.lines(Symbol(), [i], () => [payload]);
  }
  cache.lines(first, snapshot, formatLines);
  assert.equal(formatLines.mock.calls.length, 4, "byte LRU evicts before count limit");
  cache.delete(first);
  cache.lines(first, snapshot, formatLines);
  assert.equal(formatLines.mock.calls.length, 5);
  const huge = vi.fn(() => ["x".repeat(MAX_STAMP_RENDER_VALUE_BYTES)]);
  const key = Symbol();
  cache.lines(key, snapshot, huge);
  cache.lines(key, snapshot, huge);
  assert.equal(huge.mock.calls.length, 2, "oversized outputs are never retained");
  const lines = cache.lines(first, snapshot, formatLines);
  const wrap = vi.mocked(tui.wrapTextWithAnsi).mockClear();
  cache.rows(first, lines, 20);
  cache.rows(first, lines, 21);
  cache.rows(first, lines, 20);
  assert.equal(wrap.mock.calls.length, 3, "old widths are not accumulated");
  cache.clear(true);
  cache.lines(first, snapshot, formatLines);
  cache.lines(first, snapshot, formatLines);
  assert.equal(formatLines.mock.calls.length, 7, "retired scopes clear and cannot repopulate");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(stampRenderSnapshot(cyclic, []), undefined);
  assert.equal(stampRenderSnapshot({ huge: "x".repeat(MAX_STAMP_RENDER_VALUE_BYTES) }, []), undefined);
  assert.equal(stampRenderSnapshot({}, ["x".repeat(MAX_STAMP_RENDER_VALUE_BYTES)]), undefined);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CustomEntry, SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { COST_ORIGIN_ENTRY_TYPE } from "../src/cost-origin.js";
import { DEFAULT_STAMP_SETTINGS } from "../src/format.js";
import type { StampSettingsRuntime, StampSettingsState } from "../src/settings.js";
import stamp, { STAMP_ENTRY_TYPE } from "../src/stamp.js";
import { createMockContext, createMockPi } from "./support.js";

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof tui>();
  return { ...actual, wrapTextWithAnsi: vi.fn(actual.wrapTextWithAnsi) };
});

// Deterministic operation counts are the gate; wall/CPU measurements are printed
// as evidence, not flaky thresholds. Everything is synthetic in a fresh temp dir.
for (const count of [100, 1_000]) {
  test(`public Pi 1.5 layout: ${count} historical stamps x 40 repaint frames avoid repeated formatting/layout`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-stamp-repaint-"));
    t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const session = SessionManager.create(directory, directory);
    const timestamp = Date.UTC(2026, 6, 30, 0, 1, 2);
    session.appendMessage({ role: "user", content: "synthetic fixture", timestamp: 0 });
    const entries: CustomEntry[] = [];
    for (let i = 0; i < count; i++) {
      const id = session.appendCustomEntry(STAMP_ENTRY_TYPE, {
        version: 4,
        role: "assistant",
        timestamp: timestamp + i * 1_000,
        previousTimestamp: timestamp - 86_400_000,
        completedAt: timestamp + i * 1_000 + 100,
        metadata: {
          api: "fixture",
          provider: "fixture",
          model: "fixture-model",
          stopReason: "stop",
          usage: { totalTokens: 100, estimatedCost: 1 },
        },
      });
      session.appendCustomEntry(COST_ORIGIN_ENTRY_TYPE, { version: 1, stampEntryId: id, cost: 1, origin: "provider" });
      const entry = session.getEntry(id);
      assert.ok(entry?.type === "custom");
      entries.push(entry);
    }
    const state: StampSettingsState = {
      settings: { ...DEFAULT_STAMP_SETTINGS, timeZone: "UTC", assistantMetadata: "compact" },
      sources: {} as StampSettingsState["sources"],
      canSave: true,
    };
    const runtime: StampSettingsRuntime = {
      get: () => state,
      getPath: () => join(directory, "unused.json"),
      reload: async () => state,
      update: async () => state,
      flush: async () => undefined,
    };
    const mock = createMockPi();
    stamp(mock.pi, { settingsRuntime: runtime });
    const { ctx } = createMockContext({ mode: "tui", sessionManager: session });
    for (const handler of mock.events.get("session_start") ?? []) await handler({}, ctx);
    const renderer = mock.entryRenderers.get(STAMP_ENTRY_TYPE);
    assert.ok(renderer);
    const theme = new Theme(
      { dim: "#777777", muted: "#888888", text: "#eeeeee", thinkingXhigh: "#cccccc" } as never,
      { selectedBg: "#222222" } as never,
      "truecolor",
    );
    const transcript = new tui.Container();
    const components = entries.map((entry) => {
      const component = renderer(entry, { expanded: false }, theme) as tui.Component;
      transcript.addChild(component);
      return component;
    });
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    const canonicalKeys = vi.spyOn(JSON, "stringify");
    const wrap = vi.mocked(tui.wrapTextWithAnsi).mockClear();
    const OriginalNumberFormat = Intl.NumberFormat;
    const numberFormats = vi.spyOn(Intl, "NumberFormat").mockImplementation(function NumberFormatter(locales, options) {
      return new OriginalNumberFormat(locales, options);
    } as typeof Intl.NumberFormat);
    const cold = transcript.render(100);
    assert.equal(cold.length, count * 2);
    assert.match(cold[1], /provider \$1/u);
    assert.equal(parts.mock.calls.length, count * 3);
    const counters = () => ({
      parts: parts.mock.calls.length,
      canonicalKeys: canonicalKeys.mock.calls.length,
      wrap: wrap.mock.calls.length,
      numberFormats: numberFormats.mock.calls.length,
    });
    const reset = () => {
      parts.mockClear();
      canonicalKeys.mockClear();
      wrap.mockClear();
      numberFormats.mockClear();
    };
    reset();
    let start = performance.now();
    let cpu = process.cpuUsage();
    for (let frame = 0; frame < 40; frame++) transcript.render(100);
    const cachedWall = performance.now() - start;
    const cachedCpu = process.cpuUsage(cpu);
    assert.deepEqual(counters(), { parts: 0, canonicalKeys: 0, wrap: 0, numberFormats: 0 });
    reset();
    start = performance.now();
    cpu = process.cpuUsage();
    for (let frame = 0; frame < 40; frame++) {
      for (const component of components) component.invalidate();
      transcript.render(100);
    }
    const uncachedWall = performance.now() - start;
    const uncachedCpu = process.cpuUsage(cpu);
    const uncached = counters();
    assert.equal(uncached.parts, count * 40 * 3);
    assert.equal(uncached.canonicalKeys, count * 40 * 3);
    assert.equal(uncached.wrap, count * 40 * 2);
    assert.equal(uncached.numberFormats, count * 40);
    assert.deepEqual(transcript.render(100), cold);
    console.info("stamp repaint evidence", {
      count,
      frames: 40,
      cachedWall,
      uncachedWall,
      cachedCpuMs: (cachedCpu.user + cachedCpu.system) / 1_000,
      uncachedCpuMs: (uncachedCpu.user + uncachedCpu.system) / 1_000,
      cached: { parts: 0, canonicalKeys: 0, wrap: 0, numberFormats: 0 },
      uncached,
    });
    for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
  });
}

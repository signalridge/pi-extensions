import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { resolveMenuScreen, runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { withBorderedCustomUi } from "@signalridge/pi-ui";
import { test } from "vitest";
import { createAnalyticsMenu } from "../src/menu.js";
import { responsePairItems, responseReviewContent } from "../src/response-screen.js";
import { type AnalyticsSnapshot, querySnapshot } from "../src/storage/queries.js";
import { createMockContext } from "./support.js";

initTheme("dark", false);

async function fixture(count = 100) {
  const snapshot = await querySnapshot([], { fromMs: 0, toMs: 10 });
  snapshot.responses.modelPairs = Array.from({ length: count }, (_, index) => ({
    provider: "provider",
    model: `requested-${index}`,
    responseModel: index === 0 ? undefined : index === 1 ? "requested-1" : `reported-${index}`,
    count: count - index,
  }));
  return snapshot;
}

function controller(snapshot: AnalyticsSnapshot) {
  let clears = 0;
  const menu = createAnalyticsMenu({
    path: "/tmp/test-analytics",
    load: async () => ({ kind: "ready", snapshot }),
    clearAll: async () => {
      clears += 1;
      return { cleanupIncomplete: false };
    },
  });
  menu.menu.start = "responses";
  return {
    ...menu,
    get clears() {
      return clears;
    },
  };
}

test("response preview is concise, explicitly bounded, and details retain every pair and original metric", async () => {
  const snapshot = await fixture();
  const ctl = controller(snapshot);
  const state = await ctl.getState({ signal: new AbortController().signal });
  const screen = resolveMenuScreen(ctl.menu, "responses", state);
  assert.equal(screen.kind, "browse");
  if (screen.kind !== "browse") return;
  assert.equal(screen.viewportSize, 7);
  assert.equal(screen.enableDetailSearch, true);
  assert.match(screen.lines?.join("\n") ?? "", /94 more pairs hidden/);
  assert.equal(screen.items.length, 101);
  const review = screen.items[0]?.detailDocument?.content ?? "";
  assert.equal(screen.items[0]?.label, "Response statistics");
  assert.match(review, /94 model pairs hidden from preview/);
  assert.match(review, /Not reported/);
  assert.match(review, /Same ID/);
  assert.match(review, /Different ID/);
  assert.doesNotMatch(review, /requested-6\b/);
  assert.ok(review.length < 2_000);
  assert.match(review, /average.*median.*P95.*maximum/);
  assert.match(review, /Distribution: 1 call.*2–3.*4–6.*7\+/);
  assert.match(screen.items[100]?.detailDocument?.content ?? "", /Requested model: requested-99/);
  assert.match(screen.items[1]?.detailDocument?.content ?? "", /Reported model: not reported/);
  assert.equal(ctl.clears, 0);
});

test("empty response previews retain the original metrics and missing request identity never implies equality", async () => {
  const ctl = controller(await fixture(0));
  const state = await ctl.getState({ signal: new AbortController().signal });
  const screen = resolveMenuScreen(ctl.menu, "responses", state);
  assert.equal(screen.kind, "browse");
  if (screen.kind !== "browse") return;
  assert.equal(screen.items.length, 1);
  assert.match(screen.items[0]?.detailDocument?.content ?? "", /No model pairs/);
  const unknown = responsePairItems([{ responseModel: "reported", count: 1 }]);
  assert.match(unknown[0].statusText, /Request unknown/);
  assert.doesNotMatch(unknown[0].statusText, /Same ID/);
});

test("long pair labels are bounded in RPC and preview without losing searchable identity or exact details", () => {
  const model = `request-${"x".repeat(4_000)}`;
  const responseModel = `report-${"y".repeat(249)}`;
  const items = responsePairItems([{ provider: "provider", model, responseModel, count: 1 }]);
  assert.ok(Array.from(items[0].label).length <= 80);
  assert.ok(items[0].label.endsWith("…"));
  assert.ok(items[0].searchText.includes(model));
  assert.ok(items[0].searchText.includes(responseModel));
  assert.ok(items[0].detailDocument.content.includes(model));
  assert.ok(items[0].detailDocument.content.includes(responseModel));
});

test("hostile requested and reported names are safe in preview, search, statuses and exact details", async () => {
  const snapshot = await fixture(1);
  snapshot.responses.modelPairs[0] = {
    provider: "provider\u001b[31m",
    model: "request\u001b]8;;https://evil.invalid\u0007name\u202e",
    responseModel: "report\n\u009b31m\u2066evil\u001b]0;owned\u0007",
    count: 1,
  };
  const preview = responseReviewContent(snapshot.responses);
  const items = responsePairItems(snapshot.responses.modelPairs);
  assert.doesNotMatch(preview + JSON.stringify(items), /\\u00(?:1b|07|9b)|\\u202e|\\u2066/iu);
  for (const text of [preview, items[0].label, items[0].statusText, items[0].detailDocument.content]) {
    for (const unsafe of ["\u001b", "\u0007", "\u009b", "\u202e", "\u2066"]) assert.equal(text.includes(unsafe), false);
  }
  assert.equal(items[0].id, "pair-0");
  assert.match(items[0].detailDocument.content, /Relationship: Different ID/);
  assert.match(items[0].detailDocument.content, /token and cost accounting is unchanged/);
});

for (const configured of [false, true]) {
  test(`adaptive preview and exact reviews honor ${configured ? "configured" : "default"} paging and confirmation keys`, async () => {
    const ctl = controller(await fixture());
    const keys = new KeybindingsManager(
      TUI_KEYBINDINGS,
      configured
        ? {
            "tui.select.pageDown": "ctrl+v",
            "tui.select.pageUp": "ctrl+b",
            "tui.select.confirm": "ctrl+y",
            "tui.select.cancel": "ctrl+g",
          }
        : {},
    );
    const tui = createTuiHarness({ width: 40, rows: 14, keybindings: keys });
    const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const owner = new AbortController();
    const running = runMenu(withBorderedCustomUi(ctx), ctl.menu, {
      getState: ctl.getState,
      signal: owner.signal,
      isCurrent: () => !owner.signal.aborted,
    });
    await tui.waitForOpen();
    for (const [width, rows] of [
      [18, 8],
      [40, 14],
      [80, 24],
      [120, 60],
      [6, 4],
    ]) {
      const frame = tui.resize({ width, rows });
      assert.ok(frame.length <= rows, `${width}x${rows}: ${frame.length}`);
      for (const line of frame) assert.ok(visibleWidth(line) <= width);
    }
    tui.resize({ width: 40, rows: 14 });
    tui.send(configured ? "\u0019" : "\r");
    assert.match(tui.render().join("\n"), /Response statistics/);
    for (const [width, rows] of [
      [18, 8],
      [40, 14],
      [80, 24],
      [120, 60],
      [6, 4],
    ]) {
      const frame = tui.resize({ width, rows });
      // The shared adapter adds its two rules to Kit's minimal one-row frame.
      assert.ok(frame.length <= Math.max(3, rows - 3), `${width}x${rows}: ${frame.length}`);
      for (const line of frame) assert.ok(visibleWidth(line) <= width);
    }
    tui.resize({ width: 40, rows: 14 });
    const initial = tui.render().join("\n");
    const paged = tui.send(configured ? "\u0016" : "\u001b[6~").join("\n");
    assert.notEqual(paged, initial);
    assert.notEqual(tui.send(configured ? "\u0002" : "\u001b[5~").join("\n"), paged);
    tui.send(configured ? "\u0007" : "\u001b");
    assert.match(tui.render().join("\n"), /Response cycles/);
    const before = tui.render().join("\n");
    assert.notEqual(tui.send(configured ? "\u0016" : "\u001b[6~").join("\n"), before);
    tui.press("end");
    assert.match(tui.render().join("\n"), /101\/101/);
    tui.send(configured ? "\u0019" : "\r");
    assert.match(tui.render().join("\n"), /Requested provider/);
    assert.match(tui.render().join("\n"), /Requested model: requested-99/);
    tui.send(configured ? "\u0007" : "\u001b");
    for (const [width, rows] of [
      [18, 8],
      [40, 14],
      [80, 24],
      [120, 60],
    ]) {
      const frame = tui.resize({ width, rows });
      assert.ok(frame.length <= rows, `${width}x${rows}: ${frame.length}`);
      for (const line of frame) assert.ok(visibleWidth(line) <= width);
    }
    assert.match(tui.render().join("\n"), /requested-99/);
    owner.abort();
    assert.equal((await running).kind, "stale");
    assert.equal(ctl.clears, 0);
  });
}

test("RPC preview and exact review pages preserve access without custom TUI or data mutation", async () => {
  const ctl = controller(await fixture());
  let selects = 0;
  const titles: string[] = [];
  const choices: string[][] = [];
  const { ctx } = createMockContext({
    mode: "rpc",
    hasUI: true,
    custom: () => assert.fail("RPC must not open TUI"),
    select: async (title: string, options: string[]) => {
      titles.push(title);
      choices.push(options);
      selects += 1;
      if (selects === 1) return options.find((option) => /Response statistics/.test(option));
      if (selects === 2) return options.find((option) => /next/i.test(option));
      if (selects === 4) return options.find((option) => /requested-0/.test(option));
      return undefined;
    },
  });
  const running = await runMenu(ctx, ctl.menu, { getState: ctl.getState });
  assert.equal(running.kind, "closed");
  assert.ok(titles.some((title) => title.includes("Response cycles")));
  assert.ok(titles.some((title) => title.includes("Requested provider:")));
  assert.ok(choices.some((options) => options.some((option) => /next/i.test(option))));
  assert.equal(ctl.clears, 0);
});

test("owner cancellation and host disposal close preview and exact reviews without Clear", async () => {
  for (const view of ["preview", "statistics", "pair"] as const) {
    const ctl = controller(await fixture());
    const tui = createTuiHarness();
    const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = runMenu(withBorderedCustomUi(ctx), ctl.menu, { getState: ctl.getState });
    await tui.waitForOpen();
    if (view === "pair") tui.press("tui.select.down");
    if (view !== "preview") tui.press("tui.select.confirm");
    tui.dispose();
    assert.deepEqual(await running, { kind: "closed", reason: "close" });
    assert.equal(ctl.clears, 0);
  }
  const ctl = controller(await fixture());
  const rpc = createRpcHarness([{ kind: "select", waitForAbort: true }]);
  const base = createMockContext({ mode: "rpc", hasUI: true }).ctx;
  const owner = new AbortController();
  const ctx = { ...base, ui: { ...base.ui, ...rpc.ui } };
  const running = runMenu(ctx, ctl.menu, { getState: ctl.getState, signal: owner.signal });
  await rpc.waitForCall();
  owner.abort();
  assert.equal((await running).kind, "stale");
  rpc.assertConsumed();
  assert.equal(ctl.clears, 0);
});

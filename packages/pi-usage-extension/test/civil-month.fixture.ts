import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { civilMonthStart } from "../civil-time.ts";
import { collectUsageData } from "../data.ts";
import { buildGraphModel } from "../graph.ts";

// Expected boundaries are explicit offsets for the zone under test, not values
// derived from the Date constructor that the production helper also uses.
const at = (iso: string) => Date.parse(iso);
const root = process.argv[2];
const phase = process.argv[3];
assert.ok(root);

if (phase === "lengths") {
  // America/New_York: 31-, 30- and 28-day months, and a month whose DST change
  // (8 March) lies between its first and now. Subtracting elapsed days from now
  // would land on 1 March 01:00 EST instead of midnight.
  for (const [now, first] of [
    ["2026-01-31T23:59:59.999-05:00", "2026-01-01T00:00:00-05:00"],
    ["2026-02-01T00:00:00-05:00", "2026-02-01T00:00:00-05:00"],
    ["2026-02-28T23:59:59.999-05:00", "2026-02-01T00:00:00-05:00"],
    ["2026-03-01T00:00:00-05:00", "2026-03-01T00:00:00-05:00"],
    ["2026-03-31T23:00:00-04:00", "2026-03-01T00:00:00-05:00"],
    ["2026-04-30T23:59:59.999-04:00", "2026-04-01T00:00:00-04:00"],
    ["2026-11-30T12:00:00-05:00", "2026-11-01T00:00:00-04:00"],
    ["2024-02-29T12:00:00-05:00", "2024-02-01T00:00:00-05:00"],
  ]) {
    assert.equal(civilMonthStart(at(now)), at(first), `${now} → ${first}`);
  }
} else if (phase === "skipped-midnight") {
  // America/Asuncion skipped 1 October 2023 00:00–01:00 for DST. The month
  // starts at the first instant that exists on the first.
  const first = at("2023-10-01T01:00:00-03:00");
  assert.equal(civilMonthStart(at("2023-10-15T12:00:00-03:00")), first);
  assert.equal(civilMonthStart(first), first);
  assert.equal(civilMonthStart(first - 1), at("2023-09-01T00:00:00-04:00"));

  const now = new Date(at("2023-10-15T12:00:00-03:00"));
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir);
  const message = (id: string, timestamp: number, cost: number) => ({
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "m",
      timestamp,
      usage: {
        cost: { total: cost },
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
  });
  const entries = [
    { type: "session", id: "month", cwd: "/projects/month" },
    message("september", first - 1, 1),
    message("october", first, 2),
    message("mid", at("2023-10-10T09:00:00-03:00"), 4),
  ];
  writeFileSync(join(sessionsDir, "s.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const data = await collectUsageData({
    sessionsDir,
    cachePath: join(root, "cache.json"),
    now,
  });
  assert.ok(data);
  assert.equal(data.bounds.thisMonthStartMs, first);
  assert.equal(data.thisMonth.totals.cost, 6);
  assert.equal(data.thisMonth.totals.messages, 2);
  const model = buildGraphModel(data.hourly, {
    period: "thisMonth",
    metric: "cost",
    groupBy: "total",
    cumulative: false,
    bounds: data.bounds,
  });
  assert.equal(model.domainStartMs, first);
  assert.equal(model.series[0]?.total, 6);
  // Daily buckets reconstruct each civil midnight after the skipped one.
  assert.equal(model.bucketStarts[1], at("2023-10-02T00:00:00-03:00"));
} else {
  throw new Error(`unknown phase ${phase}`);
}

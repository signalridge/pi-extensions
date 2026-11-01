import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectUsageData, TAB_ORDER } from "../data.ts";
import { buildGraphCsv, buildTableCsv } from "../export.ts";
import { buildGraphModel, renderChart } from "../graph.ts";

const root = process.argv[2];
const phase = process.argv[3];
assert.ok(root);
const sessionsDir = join(root, "sessions");
mkdirSync(sessionsDir);
let now: Date;
let timestamps: number[];
let hourStarts: number[];
const instants = (values: string[]) => values.map(Date.parse);
if (phase === "spring") {
  now = new Date(2026, 2, 8, 12);
  timestamps = instants([
    "2026-03-07T23:59:00-05:00",
    "2026-03-08T00:10:00-05:00",
    "2026-03-08T01:55:00-05:00",
    "2026-03-08T03:05:00-04:00",
  ]);
  hourStarts = instants([
    "2026-03-07T23:00:00-05:00",
    "2026-03-08T00:00:00-05:00",
    "2026-03-08T01:00:00-05:00",
    "2026-03-08T03:00:00-04:00",
  ]);
} else if (phase === "fall") {
  now = new Date(2026, 10, 1, 12);
  timestamps = instants([
    "2026-10-31T23:59:00-04:00",
    "2026-11-01T00:10:00-04:00",
    "2026-11-01T01:10:00-04:00",
    "2026-11-01T01:10:00-05:00",
  ]);
  hourStarts = instants([
    "2026-10-31T23:00:00-04:00",
    "2026-11-01T00:00:00-04:00",
    "2026-11-01T01:00:00-04:00",
    "2026-11-01T01:00:00-05:00",
  ]);
} else if (phase === "partial-spring") {
  now = new Date(2026, 9, 4, 12);
  timestamps = instants([
    "2026-10-03T23:59:00+10:30",
    "2026-10-04T00:10:00+10:30",
    "2026-10-04T01:55:00+10:30",
    "2026-10-04T02:35:00+11:00",
    "2026-10-04T03:25:00+11:00",
    "2026-10-04T03:55:00+11:00",
    "2026-10-04T04:05:00+11:00",
  ]);
  hourStarts = instants([
    "2026-10-03T23:00:00+10:30",
    "2026-10-04T00:00:00+10:30",
    "2026-10-04T01:00:00+10:30",
    "2026-10-04T02:30:00+11:00",
    "2026-10-04T03:00:00+11:00",
    "2026-10-04T03:00:00+11:00",
    "2026-10-04T04:00:00+11:00",
  ]);
} else if (phase === "partial-fall") {
  now = new Date(2026, 3, 5, 12);
  timestamps = instants([
    "2026-04-04T23:59:00+11:00",
    "2026-04-05T00:10:00+11:00",
    "2026-04-05T01:35:00+11:00",
    "2026-04-05T01:35:00+10:30",
    "2026-04-05T02:25:00+10:30",
    "2026-04-05T02:55:00+10:30",
    "2026-04-05T03:05:00+10:30",
  ]);
  hourStarts = instants([
    "2026-04-04T23:00:00+11:00",
    "2026-04-05T00:00:00+11:00",
    "2026-04-05T01:00:00+11:00",
    "2026-04-05T01:30:00+10:30",
    "2026-04-05T02:00:00+10:30",
    "2026-04-05T02:00:00+10:30",
    "2026-04-05T03:00:00+10:30",
  ]);
} else if (phase === "midnight" || phase === "midnight-today") {
  now = new Date(2026, 8, phase === "midnight" ? 7 : 6, 12);
  timestamps = instants([
    "2026-09-05T23:59:00-04:00",
    "2026-09-06T01:10:00-03:00",
    "2026-09-07T00:10:00-03:00",
    "2026-09-07T01:10:00-03:00",
  ]);
  hourStarts = instants([
    "2026-09-05T23:00:00-04:00",
    "2026-09-06T01:00:00-03:00",
    "2026-09-07T00:00:00-03:00",
    "2026-09-07T01:00:00-03:00",
  ]);
  if (phase === "midnight-today") {
    timestamps = timestamps.slice(0, 2);
    hourStarts = hourStarts.slice(0, 2);
  }
} else {
  now = new Date(2026, 6, 13, 12); // Monday
  timestamps = [new Date(2026, 6, 12, 23, 59).getTime(), new Date(2026, 6, 13, 0, 10).getTime()];
  hourStarts = [new Date(2026, 6, 12, 23).getTime(), new Date(2026, 6, 13).getTime()];
}
if (phase.startsWith("partial-")) assert.equal(timestamps[4] - timestamps[3], 50 * 60_000);
const entries = [
  { type: "session", id: "civil", cwd: "/projects/civil" },
  ...timestamps.map((timestamp, index) => ({
    type: "message",
    id: `m-${index}`,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "m",
      timestamp,
      usage: { cost: { total: 2 ** index }, input: 10 * (index + 1), output: index + 1, cacheRead: 0, cacheWrite: 2 },
    },
  })),
];
const journal = join(sessionsDir, "session.jsonl");
writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join("\n"));
const originalBytes = readFileSync(journal);
const cachePath = join(root, "cache.json");
// Independent expected civil dates and explicit physical-hour markers above;
// do not derive expected indices from the production boundary helpers.
const dateStart = (time: number, delta = 0) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta).getTime();
};
const sinceMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
// Months in these phases start on a civil date with an ordinary midnight.
const monthStart = (time: number) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
};
const expectedBounds = {
  todayMs: dateStart(now.getTime()),
  weekStartMs: dateStart(now.getTime(), -sinceMonday),
  lastWeekStartMs: dateStart(now.getTime(), -sinceMonday - 7),
  thisMonthStartMs: monthStart(now.getTime()),
  last30DaysStartMs: dateStart(now.getTime(), -29),
  nowMs: now.getTime(),
};
for (let pass = 0; pass < 2; pass++) {
  const progress = [];
  const data = await collectUsageData({ sessionsDir, cachePath, now, onProgress: (event) => progress.push(event) });
  assert.ok(data);
  assert.equal(progress[0].filesToParse, pass === 0 ? 1 : 0);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 12, "actual v12 cache payload");
  assert.deepEqual(readFileSync(journal), originalBytes);
  assert.deepEqual(data.bounds, expectedBounds);
  assert.deepEqual(
    [...data.hourly.keys()].sort((a, b) => a - b),
    [...new Set(hourStarts)].sort((a, b) => a - b),
  );
  const startByPeriod = {
    today: expectedBounds.todayMs,
    thisWeek: expectedBounds.weekStartMs,
    lastWeek: expectedBounds.lastWeekStartMs,
    thisMonth: expectedBounds.thisMonthStartMs,
    last30Days: expectedBounds.last30DaysStartMs,
    allTime: -Infinity,
  };
  for (const period of TAB_ORDER) {
    const end = period === "lastWeek" ? expectedBounds.weekStartMs : now.getTime();
    for (const metric of ["cost", "tokens", "messages"] as const) {
      const value = (index: number) =>
        metric === "cost" ? 2 ** index : metric === "messages" ? 1 : 11 * (index + 1) + 2;
      const model = buildGraphModel(data.hourly, {
        period,
        metric,
        groupBy: "total",
        cumulative: false,
        bounds: data.bounds,
      });
      const expectedPoints = model.bucketStarts.map(() => 0);
      for (const [index, timestamp] of timestamps.entries()) {
        if (timestamp < startByPeriod[period] || timestamp >= end) continue;
        const expectedStart = model.bucketMs === 3_600_000 ? hourStarts[index] : dateStart(timestamp);
        const bucketIndex = model.bucketStarts.indexOf(expectedStart);
        assert.ok(
          bucketIndex >= 0,
          `${process.env.TZ}/${phase}/${period}: missing ${new Date(expectedStart).toISOString()}`,
        );
        expectedPoints[bucketIndex] += value(index);
      }
      const expectedTotal = expectedPoints.reduce((sum, point) => sum + point, 0);
      const tableTotal =
        metric === "cost"
          ? data[period].totals.cost
          : metric === "messages"
            ? data[period].totals.messages
            : data[period].totals.tokens.total;
      assert.equal(tableTotal, expectedTotal);
      assert.equal(model.series[0]?.total, expectedTotal);
      assert.deepEqual(model.series[0]?.points, expectedPoints, "exact bucket attribution, not just conserved totals");
      const csvRows = buildGraphCsv(model)
        .trim()
        .split("\n")
        .slice(1)
        .map((row) => row.split(","));
      assert.deepEqual(
        csvRows,
        model.bucketStarts.map((start, i) => [new Date(start).toISOString(), String(expectedPoints[i])]),
      );
      const tableRow = buildTableCsv(data[period].providers, data[period].totals).trim().split("\n").at(-1)?.split(",");
      assert.equal(Number(tableRow?.[metric === "cost" ? 4 : metric === "messages" ? 3 : 5]), expectedTotal);
      if (period === "last30Days")
        for (const start of model.bucketStarts)
          assert.equal(start, dateStart(start), "fresh civil midnight after a skipped midnight");
      const labels: number[] = [];
      renderChart(model, {
        width: 80,
        height: 4,
        formatValue: String,
        formatTime: (time) => {
          labels.push(time);
          return new Date(time).toTimeString().slice(0, 5);
        },
      });
      assert.equal(labels[0], model.domainStartMs);
      assert.equal(labels[1], model.domainEndMs);
    }
  }
}

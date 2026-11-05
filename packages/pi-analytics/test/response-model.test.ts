import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { ResponseCollector } from "../src/collector.js";
import { MAX_RESPONSE_MODEL_LENGTH } from "../src/reported-model.js";
import { AnalyticsRunFiles } from "../src/storage/files.js";
import { decodeStoredRun, encodeStoredRun } from "../src/storage/format.js";
import { querySnapshot } from "../src/storage/queries.js";
import { AnalyticsStore } from "../src/storage/store.js";
import type { SettledRun } from "../src/types.js";

function collected(responseModel: unknown, id = "run", requested = "alias"): SettledRun {
  const collector = new ResponseCollector();
  collector.begin({ id, now: 1, triggerSource: "rpc", model: { provider: "router", model: "selected" } });
  collector.beginGeneration({ id: "generation", now: 2 });
  collector.finishGeneration({
    now: 3,
    stopReason: "stop",
    model: { provider: "physical", model: requested, thinkingLevel: "high" },
    responseModel,
  });
  const run = collector.settle(4);
  assert.ok(run);
  return run;
}

const invalidModels: unknown[] = [null, 17, {}, [], "", " \t\n", "x".repeat(MAX_RESPONSE_MODEL_LENGTH + 1)];

test("collector stores only explicitly reported bounded strings, including equal and different IDs", () => {
  for (const value of [undefined, ...invalidModels, "alias", "snapshot", "x".repeat(MAX_RESPONSE_MODEL_LENGTH)]) {
    const run = collected(value);
    const generation = run.generations[0];
    assert.ok(generation);
    const expected =
      typeof value === "string" && value.trim() && value.length <= MAX_RESPONSE_MODEL_LENGTH ? value : undefined;
    assert.equal(generation.responseModel, expected);
    assert.equal(Object.hasOwn(generation, "responseModel"), expected !== undefined);
    assert.equal(generation.provider, "physical");
    assert.equal(generation.model, "alias");
    assert.equal(generation.thinkingLevel, "high");
    assert.equal(run.initialModel, "selected");
    assert.equal(run.generations.length, 1);
  }
});

test("historical absent and new reported fields round-trip without a format migration or accidental content", () => {
  for (const value of [undefined, "alias", "snapshot"]) {
    const run = collected(value);
    const encoded = encodeStoredRun(run);
    assert.equal(JSON.parse(encoded).formatVersion, 1);
    const decoded = decodeStoredRun(encoded);
    assert.equal(decoded.generations[0]?.responseModel, value);
    assert.equal(Object.hasOwn(decoded.generations[0] ?? {}, "responseModel"), value !== undefined);
    assert.deepEqual(decodeStoredRun(encodeStoredRun(decoded)), decoded);
  }
  for (const responseModel of invalidModels) {
    const run = collected(undefined);
    const envelope = JSON.parse(encodeStoredRun(run));
    envelope.run.generations[0].responseModel = responseModel;
    assert.throws(() => decodeStoredRun(JSON.stringify(envelope)), /invalid.*responseModel/);
    Object.assign(run.generations[0] ?? {}, { responseModel });
    assert.throws(() => encodeStoredRun(run), /invalid.*responseModel/);
  }
  const run = collected("snapshot");
  Object.assign(run.generations[0] ?? {}, { diagnostics: "secret", prompt: "private" });
  assert.doesNotMatch(encodeStoredRun(run), /secret|private|diagnostics|prompt/);
});

test("pair aggregation separates missing, same and different reports, providers and exact model IDs", async () => {
  const rows = [
    collected(undefined, "missing"),
    collected("alias", "same"),
    collected("snapshot", "different-1"),
    collected("snapshot", "different-2"),
    collected("snapshot", "other-request", "another"),
    collected("snapshot", "other-provider"),
    collected("ignored", "outside-range"),
  ];
  rows[5].generations[0].provider = "other";
  rows[6].startedAtMs = 100;
  const result = await querySnapshot([...rows, rows[0]], { fromMs: 0, toMs: 10 });
  assert.equal(result.responses.count, 6);
  assert.equal(result.responses.llmCalls, 6);
  assert.equal(result.responses.modelPairs.length, 5);
  assert.deepEqual(result.responses.modelPairs[0], {
    provider: "physical",
    model: "alias",
    responseModel: "snapshot",
    count: 2,
  });
  assert.equal(result.responses.modelPairs.find((pair) => pair.responseModel === undefined)?.count, 1);
  assert.equal(result.responses.modelPairs.find((pair) => pair.responseModel === "alias")?.count, 1);
  assert.equal(
    result.responses.modelPairs.reduce((sum, pair) => sum + pair.count, 0),
    6,
  );
  const owner = new AbortController();
  owner.abort();
  await assert.rejects(querySnapshot(rows, { fromMs: 0, toMs: 10 }, owner.signal), /abort/i);
});

test("old and new disk frames reopen with absent metadata preserved and clear removes both", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "analytics-reported-model-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const writer = new AnalyticsStore(root);
  await writer.recordRun(collected(undefined, "old"));
  await writer.recordRun(collected("snapshot", "new"));
  await writer.close();
  const reader = new AnalyticsRunFiles(root);
  t.onTestFinished(() => reader.close());
  const rows: SettledRun[] = [];
  for await (const run of reader.read()) rows.push(run);
  assert.deepEqual(
    rows.map((run) => run.generations[0]?.responseModel),
    [undefined, "snapshot"],
  );
  assert.equal(Object.hasOwn(rows[0].generations[0], "responseModel"), false);
  const reopened = new AnalyticsStore(root);
  t.onTestFinished(() => reopened.close());
  assert.equal((await reopened.getSnapshot({ fromMs: 0, toMs: 10 })).responses.modelPairs.length, 2);
  await reopened.clearAll();
  assert.deepEqual((await reopened.getSnapshot({ fromMs: 0, toMs: 10 })).responses.modelPairs, []);
});

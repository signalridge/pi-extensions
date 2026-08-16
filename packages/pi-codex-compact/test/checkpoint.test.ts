import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  buildReplacementHistory,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  latestCheckpoint,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "../src/checkpoint.js";

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function rawUser(text: string) {
  return { role: "user", content: [{ type: "input_text", text }] };
}

const opaque = { type: "compaction", encrypted_content: "opaque" };

function checkpoint(kept: AgentMessage[] = [user("kept", 2)], id = "checkpoint-123") {
  return createCheckpointDetails({
    modelId: "gpt-5.6",
    replacementHistory: [rawUser("old"), opaque],
    keptMessages: kept,
    checkpointId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

test("builds newest-first bounded replacement history and puts opaque item last", () => {
  const history = buildReplacementHistory(
    [rawUser("oldest"), { type: "compaction", encrypted_content: "old" }, rawUser("newest")],
    opaque,
    { tokenBudget: 2, byteBudget: 2048 },
  );
  assert.equal(history.at(-1)?.type, "compaction");
  assert.equal(history.at(-1)?.encrypted_content, "opaque");
  assert.match(JSON.stringify(history), /newest/);
  assert.doesNotMatch(JSON.stringify(history), /encrypted_content":"old/);
});

test("partially truncates the oldest fitting text item", () => {
  const history = buildReplacementHistory([rawUser("abcdefghijklmnopqrstuvwxyz".repeat(4))], opaque, {
    tokenBudget: 10,
    byteBudget: 2048,
  });
  assert.equal(history.length, 2);
  assert.match(JSON.stringify(history[0]), /\[truncated\]/);
  assert.match(JSON.stringify(history[0]), /wxyz/);
});

test("drops media that cannot fit the checkpoint byte budget", () => {
  const media = {
    role: "user",
    content: [{ type: "input_image", image_url: `data:image/png;base64,${"x".repeat(1024)}` }],
  };
  const history = buildReplacementHistory([rawUser("small"), media], opaque, {
    tokenBudget: 100,
    byteBudget: 512,
  });
  assert.equal(history.length, 2);
  assert.match(JSON.stringify(history[0]), /small/);
  assert.doesNotMatch(JSON.stringify(history), /input_image/);
});

test("validates versioned details and rejects malformed or unbounded persisted data", () => {
  const details = checkpoint();
  assert.deepEqual(parseCheckpointDetails(details), details);
  assert.equal(parseCheckpointDetails({ ...details, version: 2 }), undefined);
  assert.equal(parseCheckpointDetails({ ...details, replacementHistory: [] }), undefined);
  assert.equal(parseCheckpointDetails({ ...details, keptMessageFingerprints: ["bad"] }), undefined);
  assert.doesNotMatch(JSON.stringify(details), /token|authorization|header/i);
});

test("projects only an exact summary and kept suffix while preserving unrelated context", () => {
  const before = user("before", 0);
  const kept = user("kept", 2);
  const after = user("after", 3);
  const details = checkpoint([kept]);
  const summary: AgentMessage = {
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp: 1,
  };
  const projected = projectCheckpointContext([before, summary, kept, after], details);
  assert.ok(projected);
  assert.deepEqual(projected?.[0], before);
  assert.equal(projected?.[1].role, "user");
  assert.match(JSON.stringify(projected?.[1]), new RegExp(details.checkpointId));
  assert.deepEqual(projected?.[2], after);
  assert.equal(projectCheckpointContext([summary, user("changed", 2), after], details), undefined);
  assert.equal(projectCheckpointContext([kept, after], details), undefined);
});

test("tolerates replayed older compaction summaries around the kept lineage after resume", () => {
  const kept = user("kept", 5);
  const after = user("after", 6);
  const details = checkpoint([kept], "checkpoint-resume");
  const summary: AgentMessage = {
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp: 4,
  };
  const replayed = (timestamp: number): AgentMessage => ({
    role: "compactionSummary",
    summary: `unrelated native compaction summary ${timestamp}`,
    tokensBefore: 10,
    timestamp,
  });

  const interleaved = projectCheckpointContext([summary, replayed(1), kept, after], details);
  assert.ok(interleaved);
  assert.match(JSON.stringify(interleaved?.[0]), /PI_CODEX_REMOTE_CHECKPOINT:checkpoint-resume/);
  assert.deepEqual(interleaved?.slice(1), [after]);

  const trailing = projectCheckpointContext([summary, kept, replayed(2), after], details);
  assert.ok(trailing);
  assert.match(JSON.stringify(trailing?.[0]), /PI_CODEX_REMOTE_CHECKPOINT:checkpoint-resume/);
  assert.deepEqual(trailing?.slice(1), [after]);

  // A summary newer than the checkpoint rewrote the very history the kept
  // fingerprints describe, so skipping it would resurrect dropped context.
  assert.equal(projectCheckpointContext([summary, replayed(9), kept, after], details), undefined);

  const legacy: AgentMessage = {
    ...summary,
    summary: [
      `OpenAI Codex Remote Compaction V2 checkpoint ${details.checkpointId} stores the older history opaquely.`,
      "Full replay requires @narumitw/pi-codex-compact and an openai-codex model.",
      "Without them, only Pi's retained recent messages remain available.",
    ].join(" "),
  };
  const legacyProjected = projectCheckpointContext([legacy, replayed(1), kept, after], details);
  assert.ok(legacyProjected);
  assert.match(JSON.stringify(legacyProjected?.[0]), /PI_CODEX_REMOTE_CHECKPOINT:checkpoint-resume/);
  assert.deepEqual(legacyProjected?.slice(1), [after]);
});

test("bounds the skip window by the checkpoint's creation time, not the anchor's placement", () => {
  const kept = user("kept", 1001);
  const recent = user("recent", 1002);
  const native: AgentMessage = {
    role: "compactionSummary",
    summary: "native compaction summary created AFTER the checkpoint",
    tokensBefore: 10,
    timestamp: 500,
  };
  const anchor = (details: ReturnType<typeof checkpoint>): AgentMessage => ({
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp: 1000,
  });

  // A hand-edited or clock-skewed session file can stamp the rendered entry long after
  // the checkpoint was created. Skipping the native summary here would delete history the
  // opaque replacement does not cover, so the older creation time has to win.
  const skewed = createCheckpointDetails({
    modelId: "gpt-5.6",
    replacementHistory: [rawUser("old"), opaque],
    keptMessages: [kept],
    checkpointId: "checkpoint-skewed",
    createdAt: new Date(10).toISOString(),
  });
  assert.equal(projectCheckpointContext([anchor(skewed), native, kept, recent], skewed), undefined);

  // Control: with an honest creation time the same summary really is older and is skipped.
  const honest = createCheckpointDetails({
    modelId: "gpt-5.6",
    replacementHistory: [rawUser("old"), opaque],
    keptMessages: [kept],
    checkpointId: "checkpoint-honest",
    createdAt: new Date(1000).toISOString(),
  });
  const projected = projectCheckpointContext([anchor(honest), native, kept, recent], honest);
  assert.ok(projected);
  assert.match(JSON.stringify(projected?.[0]), /PI_CODEX_REMOTE_CHECKPOINT:checkpoint-honest/);
  assert.deepEqual(projected?.slice(1), [recent]);
});

test("never injects a non-finite marker timestamp", () => {
  const kept = user("kept", 2);
  const after = user("after", 3);
  const anchorless = (details: ReturnType<typeof checkpoint>): AgentMessage => ({
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp: Number.NaN,
  });

  const details = checkpoint([kept], "checkpoint-nan");
  const projected = projectCheckpointContext([anchorless(details), kept, after], details);
  assert.ok(projected);
  assert.equal(projected?.[0].timestamp, Date.parse(details.createdAt));

  // Neither timestamp is usable; the marker still has to serialize as a number.
  const undated = createCheckpointDetails({
    modelId: "gpt-5.6",
    replacementHistory: [rawUser("old"), opaque],
    keptMessages: [kept],
    checkpointId: "checkpoint-undated",
    createdAt: "not a date",
  });
  const undatedProjection = projectCheckpointContext([anchorless(undated), kept, after], undated);
  assert.equal(undatedProjection?.[0].timestamp, 0);
});

test("rejects a kept lineage shorter than its fingerprints without accepting a partial match", () => {
  const first = user("first", 2);
  const second = user("second", 3);
  const details = checkpoint([first, second], "checkpoint-truncated");
  const summary: AgentMessage = {
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp: 1,
  };

  assert.equal(projectCheckpointContext([summary, first], details), undefined);
  assert.ok(projectCheckpointContext([summary, first, second], details));
});

test("anchors on an older render when the newest one's lineage no longer matches", () => {
  const kept = user("kept", 5);
  const after = user("after", 6);
  const recent = user("recent", 42);
  const details = checkpoint([kept], "checkpoint-dual");
  const render = (timestamp: number): AgentMessage => ({
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp,
  });
  const replayed: AgentMessage = {
    role: "compactionSummary",
    summary: "unrelated native compaction summary",
    tokensBefore: 10,
    timestamp: 1,
  };

  // Two renders of one checkpoint only occur in a hand-edited session file, but the
  // newest-first search deliberately falls back rather than refusing outright. Pin that,
  // including the stale render left behind in the projection.
  const projected = projectCheckpointContext(
    [render(4), replayed, kept, after, render(40), user("different", 41), recent],
    details,
  );
  assert.ok(projected);
  assert.match(JSON.stringify(projected?.[0]), /PI_CODEX_REMOTE_CHECKPOINT:checkpoint-dual/);
  assert.equal(projected?.[0].timestamp, 4);
  assert.deepEqual(projected?.slice(1), [after, render(40), user("different", 41), recent]);
});

test("restores the legacy namespace summary without relaxing payload validation", () => {
  const kept = user("kept", 2);
  const details = checkpoint([kept], "checkpoint-legacy");
  const legacySummary: AgentMessage = {
    role: "compactionSummary",
    summary: [
      `OpenAI Codex Remote Compaction V2 checkpoint ${details.checkpointId} stores the older history opaquely.`,
      "Full replay requires @narumitw/pi-codex-compact and an openai-codex model.",
      "Without them, only Pi's retained recent messages remain available.",
    ].join(" "),
    tokensBefore: 100,
    timestamp: 1,
  };
  const projected = projectCheckpointContext([legacySummary, kept, user("later", 3)], details);
  assert.ok(projected);
  assert.match(JSON.stringify(projected?.[0]), /PI_CODEX_REMOTE_CHECKPOINT:checkpoint-legacy/);

  assert.equal(
    projectCheckpointContext(
      [{ ...legacySummary, summary: `${legacySummary.summary} corrupted` }, kept, user("later", 3)],
      details,
    ),
    undefined,
  );
  assert.equal(projectCheckpointContext([legacySummary, user("different", 2), user("later", 3)], details), undefined);
  assert.equal(parseCheckpointDetails({ ...details, replacementHistory: [{ type: "not-compaction" }] }), undefined);
});

test("uses canonical SHA-256 message fingerprints", () => {
  const message = user("same");
  assert.match(fingerprintMessage(message), /^[a-f0-9]{64}$/);
  assert.equal(fingerprintMessage(message), fingerprintMessage({ ...message }));
  assert.notEqual(fingerprintMessage(message), fingerprintMessage(user("different")));
  assert.match(checkpointMarker("checkpoint-123"), /injection failed/i);
});

test("selects the newest valid checkpoint on the active branch and ignores forks before it", () => {
  const first = checkpoint([], "checkpoint-first");
  const second = checkpoint([], "checkpoint-second");
  const entry = (id: string, details: ReturnType<typeof checkpoint>, parentId: string | null): CompactionEntry => ({
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: fallbackSummary(details.checkpointId),
    firstKeptEntryId: "kept",
    tokensBefore: 10,
    details,
  });
  const branch = [entry("first", first, null), entry("second", second, "first")] as SessionEntry[];
  assert.equal(latestCheckpoint(branch)?.details.checkpointId, "checkpoint-second");
  assert.equal(latestCheckpoint(branch.slice(0, 1))?.details.checkpointId, "checkpoint-first");
  const native = {
    ...entry("native", second, "second"),
    details: undefined,
    summary: "native summary",
  };
  assert.equal(latestCheckpoint([...branch, native])?.details.checkpointId, "checkpoint-second");
  assert.equal(latestCheckpoint([]), undefined);
});

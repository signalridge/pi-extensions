import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  type CachedFileState,
  collectUsageData,
  loadUsageCache,
  parseSessionBuffer,
  projectLabelFromCwd,
  saveUsageCache,
} from "../data.ts";

// 2026-07-15 is a Wednesday. Week = Mon 13th 00:00 → …, last week = Mon 6th → Sun 12th.
const NOW = new Date(2026, 6, 15, 12, 0, 0);
const TS_TODAY = new Date(2026, 6, 15, 9, 0, 0).getTime();
const TS_THIS_WEEK = new Date(2026, 6, 14, 10, 0, 0).getTime(); // Tuesday this week
const TS_LAST_WEEK = new Date(2026, 6, 10, 10, 0, 0).getTime(); // Friday last week
const TS_OLD = new Date(2026, 5, 1, 10, 0, 0).getTime(); // 1 June — outside the 30-day window
const TS_30D_EDGE_IN = new Date(2026, 5, 16, 0, 0, 0).getTime(); // midnight 29 days before 15 July — first instant inside
const TS_30D_EDGE_OUT = new Date(2026, 5, 15, 23, 59, 59).getTime(); // one second earlier — outside

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "usage-data-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  return { root, sessionsDir, cachePath: join(root, "cache.json") };
}

function sessionLine(id, ts, cwd = "/tmp", parentSession?: string) {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: new Date(ts).toISOString(),
    cwd,
    ...(parentSession ? { parentSession } : {}),
  });
}

function usage({ cost = 1, input = 100, output = 50, cacheRead = 0, cacheWrite = 0, reasoning = 0 } = {}) {
  return { input, output, cacheRead, cacheWrite, reasoning, cost: { total: cost } };
}

function assistantLine({
  id = "m1",
  parentId = null,
  ts,
  provider = "anthropic",
  model = "claude-fable-5",
  responseModel,
  cost = 1,
  input = 100,
  output = 50,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
}) {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider,
      model,
      ...(responseModel ? { responseModel } : {}),
      usage: usage({ cost, input, output, cacheRead, cacheWrite, reasoning }),
      timestamp: ts,
    },
  });
}

function toolResultLine({ id = "tool1", parentId = null, ts, ...usageValues }) {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "nested_llm",
      content: [{ type: "text", text: "done" }],
      usage: usage(usageValues),
      isError: false,
      timestamp: ts,
    },
  });
}

function childUsage(values = {}) {
  const persisted = usage(values);
  return { ...persisted, cost: persisted.cost.total, turns: 1 };
}

function nestedToolResultLine({
  id = "nested1",
  ts,
  runId = "run-a",
  reported = null,
  children = [],
  content = "done",
}) {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "subagent",
      content: [{ type: "text", text: content }],
      details: {
        mode: children.length > 1 ? "parallel" : "single",
        runId,
        results: children.map((child, index) => ({
          agent: `agent-${index}`,
          task: "test",
          exitCode: 0,
          ...(child.messages ? { messages: child.messages } : {}),
          usage: childUsage(child),
          ...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
        })),
      },
      ...(reported ? { usage: usage(reported) } : {}),
      isError: false,
      timestamp: ts,
    },
  });
}

function usageEntryLine({
  id = "usage1",
  parentId = null,
  ts,
  kind = "cache_warm",
  provider = "anthropic",
  model = "claude-fable-5",
  ...usageValues
}) {
  return JSON.stringify({
    type: "usage",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    kind,
    provider,
    model,
    usage: usage(usageValues),
  });
}

function contextEditLine(id: string, ts: number, targetId: string, parentId = targetId, replacement = null) {
  return JSON.stringify({
    type: "context_edit",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    targetId,
    replacement,
  });
}

function compactionLine({ id = "compact1", parentId = null, firstKeptEntryId = "kept", ts, ...usageValues }) {
  return JSON.stringify({
    type: "compaction",
    id,
    parentId,
    timestamp: new Date(ts).toISOString(),
    summary: "summary",
    firstKeptEntryId,
    tokensBefore: 1000,
    usage: usage(usageValues),
  });
}

function branchSummaryLine({ id = "branch1", ts, ...usageValues }) {
  return JSON.stringify({
    type: "branch_summary",
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    fromId: "old-leaf",
    summary: "branch summary",
    usage: usage(usageValues),
  });
}

function thinkingLine(level, ts) {
  return JSON.stringify({
    type: "thinking_level_change",
    id: "t1",
    timestamp: new Date(ts).toISOString(),
    thinkingLevel: level,
  });
}

function withoutParentLink(line: string): string {
  const entry = JSON.parse(line);
  delete entry.parentId;
  return JSON.stringify(entry);
}

function userLine(ts, text = "hello") {
  return JSON.stringify({
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

// =============================================================================
// parseSessionBuffer
// =============================================================================

test("parseSessionBuffer extracts session id and assistant messages from compact JSONL", async () => {
  const content = [
    sessionLine("s1", TS_TODAY),
    userLine(TS_TODAY),
    assistantLine({ ts: TS_TODAY, cost: 2.5, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }),
    '{"type":"message","id":"t","message":{"role":"toolResult","content":[{"type":"text","text":"big blob"}]}}',
    "not json at all {{{",
    assistantLine({ ts: TS_TODAY + 1000, cost: 1 }),
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.equal(parsed.sessionId, "s1");
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(parsed.messages[0], {
    provider: "anthropic",
    model: "claude-fable-5",
    thinkingLevel: "",
    source: "assistant",
    sourceId: "m1",
    cost: 2.5,
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    reasoning: 0,
    timestamp: TS_TODAY,
    afterCompaction: false,
    previousAssistantId: "",
  });
  assert.equal(parsed.cwd, "/tmp");
});

test("parseSessionBuffer extracts Pi 0.81 tool and summary usage without consuming compaction state", async () => {
  const content = [
    sessionLine("s1", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY, cost: 1 }),
    toolResultLine({
      id: "tool-usage",
      parentId: "first",
      ts: TS_TODAY + 1000,
      cost: 2,
      input: 20,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      reasoning: 1,
    }),
    compactionLine({ id: "compact-usage", parentId: "tool-usage", ts: TS_TODAY + 2000, cost: 3, input: 30, output: 3 }),
    // Python-style spacing exercises the branch-summary pre-filter variant.
    `{"type": "branch_summary", "id": "branch-usage", "parentId": "compact-usage", "timestamp": "${new Date(TS_TODAY + 3000).toISOString()}", "fromId": "old", "summary": "branch", "usage": ${JSON.stringify(usage({ cost: 4, input: 40, output: 4 }))}}`,
    assistantLine({ id: "second", parentId: "branch-usage", ts: TS_TODAY + 4000, cost: 5 }),
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.equal(parsed.messages.length, 4);
  assert.deepEqual(
    parsed.messages.map((m) => m.source),
    ["assistant", "auxiliary", "auxiliary", "assistant"],
  );
  assert.deepEqual(
    parsed.messages.map((m) => m.cost),
    [1, 3, 4, 5],
  );
  assert.deepEqual(
    parsed.messages.slice(1, 3).map((m) => [m.provider, m.model, m.thinkingLevel]),
    [
      ["Tools", "summaries", "Tools/summaries"],
      ["Tools", "summaries", "Tools/summaries"],
    ],
  );
  assert.deepEqual(
    parsed.messages.slice(1, 3).map((m) => m.sourceId),
    ["compact-usage", "branch-usage"],
  );
  assert.equal(parsed.toolUsages.length, 1);
  assert.equal(parsed.toolUsages[0].sourceId, "tool-usage");
  assert.equal(parsed.toolUsages[0].reportedUsage.cost, 2);
  assert.equal(parsed.toolUsages[0].reportedUsage.reasoning, 1);
  assert.equal(parsed.toolUsages[0].timestamp, TS_TODAY + 1000);
  assert.equal(
    parsed.messages[3].afterCompaction,
    true,
    "auxiliary entries must not clear the pending compaction marker",
  );
});

test("parseSessionBuffer reads model-attributed standalone usage without inventing assistant turns", async () => {
  const content = [
    sessionLine("s1", TS_TODAY),
    thinkingLine("high", TS_TODAY),
    withoutParentLink(
      usageEntryLine({ id: "warm-a", ts: TS_TODAY + 1000, input: 0, output: 0, cacheRead: 50_000, cost: 0.015 }),
    ),
    // Unknown kinds are still usage; spaced JSON exercises the other pre-filter.
    `{"type": "usage", "id": "other", "timestamp": "${new Date(TS_TODAY + 2000).toISOString()}", "kind": "future_kind", "provider": "openai", "model": "gpt-5", "usage": ${JSON.stringify(usage({ cost: 2, input: 20 }))}}`,
    // No model attribution or accounting data means no fabricated usage record.
    `{"type":"usage","id":"missing-model","provider":"anthropic","usage":${JSON.stringify(usage({ cost: 99 }))}}`,
    '{"type":"usage","id":"empty","provider":"anthropic","model":"m","usage":{"cost":{"total":0}}}',
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(
    parsed.messages.map((m) => [m.source, m.sourceId, m.provider, m.model, m.thinkingLevel, m.cost]),
    [
      ["usage", "warm-a", "anthropic", "claude-fable-5", "high", 0.015],
      ["usage", "other", "openai", "gpt-5", "high", 2],
    ],
  );
  assert.equal(parsed.messages[0].cacheRead, 50_000);
  assert.equal(parsed.messages[0].cacheWarm, true);
  assert.equal(parsed.messages[1].cacheWarm, undefined, "other usage kinds must not refresh cache TTL");
});

test("parseSessionBuffer keeps context edits pending across non-message usage", async () => {
  const content = [
    sessionLine("s1", TS_TODAY),
    assistantLine({ id: "m0", ts: TS_TODAY, cost: 1 }),
    contextEditLine("edit-a", TS_TODAY + 1000, "m0"),
    usageEntryLine({ id: "warm-a", parentId: "edit-a", ts: TS_TODAY + 2000, cost: 0.5 }),
    assistantLine({ id: "m1", parentId: "warm-a", ts: TS_TODAY + 3000, cost: 2 }),
    assistantLine({ id: "m2", parentId: "m1", ts: TS_TODAY + 4000, cost: 3 }),
    // Spaced context_edit is also recognized.
    `{"type": "context_edit", "id": "edit-b", "parentId": "m2", "targetId": "m2", "replacement": null}`,
    assistantLine({ id: "m3", parentId: "edit-b", ts: TS_TODAY + 5000, cost: 4 }),
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.deepEqual(
    parsed.messages.filter((m) => m.source === "assistant").map((m) => Boolean(m.afterContextEdit)),
    [false, true, false, true],
  );
  assert.equal(parsed.messages[1].source, "usage", "cache warming must not consume the context-edit boundary");
});

test("edits follow Pi custom entry order through nested and large content, not sibling branches", async () => {
  const custom = JSON.stringify({
    type: "custom",
    customType: "extension",
    data: { id: "nested-id", parentId: "sibling", content: "x".repeat(100_000) },
    id: "custom",
    parentId: "edit",
    timestamp: new Date(TS_TODAY + 2000).toISOString(),
  });
  const customMessage = JSON.stringify({
    type: "custom_message",
    customType: "extension",
    content: [{ type: "text", text: "data" }],
    display: false,
    details: { parentId: "sibling" },
    id: "custom-message",
    parentId: "custom",
    timestamp: new Date(TS_TODAY + 3000).toISOString(),
  });
  const lines = [
    sessionLine("s1", TS_TODAY),
    assistantLine({ id: "common", ts: TS_TODAY }),
    contextEditLine("edit", TS_TODAY + 1000, "common"),
    assistantLine({ id: "sibling", parentId: "common", ts: TS_TODAY + 1500 }),
    custom,
    customMessage,
    assistantLine({ id: "edited", parentId: "custom-message", ts: TS_TODAY + 4000 }),
    assistantLine({ id: "later", parentId: "edited", ts: TS_TODAY + 5000 }),
  ];
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => Boolean(m.afterContextEdit)),
    [false, false, true, false],
  );
});

test("skipped user lineage follows Pi's decoded, last-wins entry id", async (t) => {
  const { sessionsDir } = fixture(t);
  for (const [name, idProperties] of [
    ["duplicate", '"id":"other","id":"user"'],
    ["escaped", '"i\\u0064":"user"'],
  ]) {
    for (const size of ["small", "large"]) {
      const user = `{"type":"message",${idProperties},"parentId":null,"message":{"role":"user","content":[{"type":"text","text":"${"x".repeat(size === "large" ? 70 * 1024 : 5)}"}]}}`;
      const lines = [
        sessionLine(`${name}-${size}`, TS_TODAY),
        user,
        assistantLine({ id: "first", parentId: "user", ts: TS_TODAY + 100, cost: 1 }),
        contextEditLine("edit", TS_TODAY + 200, "user", "first"),
        assistantLine({ id: "second", parentId: "edit", ts: TS_TODAY + 300, cost: 5 }),
      ];
      const file = join(sessionsDir, `${name}-${size}.jsonl`);
      const jsonl = `${lines.join("\n")}\n`;
      writeFileSync(file, jsonl);

      // Pi's on-disk loader uses JSON.parse; its real projection is the
      // reference for which user entry the edit removes from model context.
      const pi = SessionManager.open(file);
      pi.branch("first");
      assert.deepEqual(
        pi.buildSessionProjection().messages.map((message) => message.role),
        ["user", "assistant"],
      );
      pi.branch("second");
      assert.deepEqual(
        pi.buildSessionProjection().messages.map((message) => message.role),
        ["assistant", "assistant"],
      );
      assert.deepEqual(
        pi
          .buildSessionProjection()
          .entries.map(({ sourceEntry, messages }) => [sourceEntry.id, messages.map((m) => m.role)]),
        [
          ["user", []],
          ["first", ["assistant"]],
          ["edit", []],
          ["second", ["assistant"]],
        ],
      );

      const parsed = await parseSessionBuffer(Buffer.from(jsonl));
      assert.deepEqual(
        parsed.messages.map((message) => [
          message.sourceId,
          message.previousAssistantId,
          Boolean(message.afterContextEdit),
        ]),
        [
          ["first", "", false],
          ["second", "first", true],
        ],
        `${name} ${size}`,
      );
    }
  }
});

test("compaction markers follow only their own branch", async () => {
  const lines = [
    sessionLine("s1", TS_TODAY),
    assistantLine({ id: "common", ts: TS_TODAY }),
    compactionLine({ id: "compact", parentId: "common", ts: TS_TODAY + 1000 }),
    assistantLine({ id: "sibling", parentId: "common", ts: TS_TODAY + 2000 }),
    assistantLine({ id: "compacted", parentId: "compact", ts: TS_TODAY + 3000 }),
    assistantLine({ id: "later", parentId: "compacted", ts: TS_TODAY + 4000 }),
  ];
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.filter((m) => m.source === "assistant").map((m) => m.afterCompaction),
    [false, false, true, false],
  );
});

test("parseSessionBuffer flags the first assistant message after a compaction entry", async () => {
  const content = [
    sessionLine("s1", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY, cost: 1 }),
    '{"type":"compaction","id":"c2","parentId":"first","summary":"..."}',
    assistantLine({ id: "second", parentId: "c2", ts: TS_TODAY + 1000, cost: 2 }),
    assistantLine({ id: "third", parentId: "second", ts: TS_TODAY + 2000, cost: 3 }),
    '{"type": "compaction", "id": "c1", "parentId": "third", "summary": "..."}',
    assistantLine({ id: "fourth", parentId: "c1", ts: TS_TODAY + 3000, cost: 4 }),
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.deepEqual(
    parsed.messages.map((m) => m.afterCompaction),
    [false, true, false, true],
  );
});

test("imported entries without parent links replay thinking changes in append order", async () => {
  const content = [
    sessionLine("s1", TS_TODAY),
    thinkingLine("high", TS_TODAY),
    withoutParentLink(assistantLine({ ts: TS_TODAY, cost: 1 })),
    thinkingLine("xhigh", TS_TODAY + 1000),
    withoutParentLink(assistantLine({ ts: TS_TODAY + 2000, cost: 2, reasoning: 55 })),
    withoutParentLink(assistantLine({ ts: TS_TODAY + 3000, cost: 3 })),
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.deepEqual(
    parsed.messages.map((m) => m.thinkingLevel),
    ["high", "xhigh", "xhigh"],
  );
  assert.equal(parsed.messages[1].reasoning, 55);
});

test("Pi root forks reset thinking for independent assistant and usage entries", async () => {
  const session = SessionManager.inMemory("/tmp");
  const highId = session.appendThinkingLevelChange("high");
  const firstId = session.appendMessage(JSON.parse(assistantLine({ ts: TS_TODAY, cost: 1 })).message);
  session.resetLeaf();
  const secondId = session.appendMessage(JSON.parse(assistantLine({ ts: TS_TODAY + 1000, cost: 2 })).message);
  session.resetLeaf();
  const warm = session.appendUsage("cache_warm", "anthropic", "claude-fable-5", {
    input: 0,
    output: 0,
    cacheRead: 50_000,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0.5, cacheWrite: 0, total: 0.5 },
  });

  assert.equal(session.getEntry(highId)?.parentId, null);
  assert.equal(session.getEntry(firstId)?.parentId, highId);
  assert.equal(session.getEntry(secondId)?.parentId, null);
  assert.equal(warm.parentId, null);
  session.branch(firstId);
  assert.equal(session.buildSessionProjection().thinkingLevel, "high");
  session.branch(secondId);
  assert.equal(session.buildSessionProjection().thinkingLevel, "off");

  const lines = [session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry));
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => [m.source, m.thinkingLevel, m.cost]),
    [
      ["assistant", "high", 1],
      ["assistant", "", 2],
      ["usage", "", 0.5],
    ],
  );
  assert.equal(
    parsed.messages.reduce((total, message) => total + message.cost, 0),
    3.5,
  );
});

test("thinking levels follow the assistant's branch rather than a later sibling change", async () => {
  const lines = [
    sessionLine("thinking-branches", TS_TODAY),
    JSON.stringify({ type: "message", id: "root", parentId: null, message: { role: "user", content: "task" } }),
    JSON.stringify({ type: "thinking_level_change", id: "low", parentId: "root", thinkingLevel: "low" }),
    assistantLine({ id: "first", parentId: "low", ts: TS_TODAY, cost: 1 }),
    JSON.stringify({ type: "thinking_level_change", id: "high", parentId: "root", thinkingLevel: "xhigh" }),
    assistantLine({ id: "second", parentId: "first", ts: TS_TODAY + 1000, cost: 2 }),
  ];
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => m.thinkingLevel),
    ["low", "low"],
  );
});

test("parseSessionBuffer handles spaced imported thinking changes and messages before any change", async () => {
  const iso = new Date(TS_TODAY).toISOString();
  const content = [
    sessionLine("s1", TS_TODAY),
    withoutParentLink(assistantLine({ ts: TS_TODAY, cost: 1 })), // before any change → unknown ("")
    `{"type": "thinking_level_change", "id": "t", "timestamp": "${iso}", "thinkingLevel": "medium"}`,
    withoutParentLink(assistantLine({ ts: TS_TODAY + 1000, cost: 2 })),
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.deepEqual(
    parsed.messages.map((m) => m.thinkingLevel),
    ["", "medium"],
  );
});

test("parseSessionBuffer handles Python-style spaced JSON", async () => {
  const content = [
    `{"type": "session", "version": 3, "id": "spaced", "timestamp": "${new Date(TS_TODAY).toISOString()}"}`,
    `{"type": "message", "id": "a", "timestamp": "${new Date(TS_TODAY).toISOString()}", "message": {"role": "assistant", "provider": "openai", "model": "gpt-5.6-sol", "usage": {"input": 5, "output": 6, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0.5}}, "timestamp": ${TS_TODAY}}}`,
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.equal(parsed.sessionId, "spaced");
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].provider, "openai");
  assert.equal(parsed.messages[0].cost, 0.5);
});

test("parseSessionBuffer ignores pre-filter false positives and messages without usage", async () => {
  const content = [
    sessionLine("s1", TS_TODAY),
    // User message quoting the assistant pattern verbatim — pre-filter hits, JSON gate rejects.
    userLine(TS_TODAY, 'observed "role":"assistant" and "type":"session" in a log'),
    // Assistant message without usage data — excluded.
    '{"type":"message","id":"n","message":{"role":"assistant","provider":"p","model":"m","content":[]}}',
    // Tool result without usage, and an explicitly empty Usage object — excluded.
    '{"type":"message","id":"t0","message":{"role":"toolResult","toolName":"x","content":[]}}',
    '{"type":"message","id":"t1","message":{"role":"toolResult","toolName":"x","content":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}}',
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.equal(parsed.sessionId, "s1");
  assert.equal(parsed.messages.length, 0);
});

test("malformed skipped entries cannot bridge a context edit through phantom lineage", async () => {
  const large = JSON.stringify({
    type: "message",
    id: "broken",
    parentId: "edit",
    message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(70 * 1024) }] },
  });
  for (const malformed of [
    '{"type":"custom","id":"broken","parentId":"edit","data":',
    '{"type":"custom","id":"broken","parentId":"edit","data":oops}',
    large.slice(0, -2),
    large.replace(/\}\}$/, "invalid}}"),
  ]) {
    const lines = [
      sessionLine("malformed", TS_TODAY),
      assistantLine({ id: "first", ts: TS_TODAY }),
      contextEditLine("edit", TS_TODAY + 100, "first"),
      malformed,
      assistantLine({ id: "next", parentId: "broken", ts: TS_TODAY + 200 }),
    ];
    const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
    assert.deepEqual(
      parsed.messages.map((m) => [m.sourceId, m.previousAssistantId, Boolean(m.afterContextEdit)]),
      [
        ["first", "", false],
        ["next", "", false],
      ],
      malformed.length > 65_536 ? "large malformed tool result" : "small malformed entry",
    );
  }
});

test("parseSessionBuffer falls back to the entry timestamp when the message has none", async () => {
  const iso = new Date(TS_TODAY).toISOString();
  const content = [
    sessionLine("s1", TS_TODAY),
    `{"type":"message","id":"a","timestamp":"${iso}","message":{"role":"assistant","provider":"p","model":"m","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.1}}}}`,
  ].join("\n");

  const parsed = await parseSessionBuffer(Buffer.from(content, "utf8"));
  assert.equal(parsed.messages[0].timestamp, TS_TODAY);
});

test("parseSessionBuffer returns empty session id when there is no header", async () => {
  const parsed = await parseSessionBuffer(Buffer.from(assistantLine({ ts: TS_TODAY }), "utf8"));
  assert.equal(parsed.sessionId, "");
  assert.equal(parsed.messages.length, 1);
});

// =============================================================================
// collectUsageData — aggregation
// =============================================================================

test("collectUsageData aggregates periods, providers, and dedupes branched history", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  mkdirSync(join(sessionsDir, "proj-a"), { recursive: true });

  // File A: one message today, one last week.
  writeFileSync(
    join(sessionsDir, "proj-a", "a.jsonl"),
    `${[
      sessionLine("s1", TS_LAST_WEEK),
      assistantLine({ ts: TS_LAST_WEEK, cost: 1, input: 100, output: 50 }),
      assistantLine({ ts: TS_TODAY, cost: 2, input: 200, output: 100, cacheWrite: 10 }),
    ].join("\n")}\n`,
  );

  // File B: a branched session that copied A's last-week message (same ts + token
  // totals → deduped) plus one unique message earlier this week.
  writeFileSync(
    join(sessionsDir, "proj-a", "b.jsonl"),
    `${[
      sessionLine("s2", TS_LAST_WEEK, "/tmp", join(sessionsDir, "proj-a", "a.jsonl")),
      assistantLine({ ts: TS_LAST_WEEK, cost: 1, input: 100, output: 50 }),
      assistantLine({ ts: TS_THIS_WEEK, cost: 4, input: 50, output: 25, provider: "openai", model: "gpt-5.6-sol" }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.ok(data);

  // Hourly buckets and bounds power the graph view.
  assert.equal(data.bounds.nowMs, NOW.getTime());
  const hourMs = 3_600_000;
  const todayHour = Math.floor(TS_TODAY / hourMs) * hourMs;
  const todayBucket = data.hourly.get(todayHour);
  assert.ok(todayBucket, "expected an hourly bucket for the today message");
  const todayCell = todayBucket.get("anthropic\u0000claude-fable-5\u0000");
  assert.equal(todayCell.cost, 2);
  assert.equal(todayCell.messages, 1);

  // All time: 3 unique messages (the copy was deduped), 2 session files.
  assert.equal(data.allTime.totals.messages, 3);
  assert.equal(data.allTime.totals.sessions, 2);
  assert.equal(data.allTime.totals.cost, 7);
  // tokens.total = input + output + cacheWrite
  assert.equal(data.allTime.totals.tokens.total, 150 + 310 + 75);

  // Periods.
  assert.equal(data.today.totals.messages, 1);
  assert.equal(data.today.totals.cost, 2);
  assert.equal(data.thisWeek.totals.messages, 2); // today + Tuesday
  assert.equal(data.lastWeek.totals.messages, 1);
  assert.equal(data.lastWeek.totals.cost, 1);
  // All three unique messages fall inside the rolling 30-day window.
  assert.equal(data.last30Days.totals.messages, 3);
  assert.equal(data.last30Days.totals.cost, 7);
  assert.equal(data.last30Days.totals.sessions, 2);

  // Provider breakdown.
  const anthropic = data.allTime.providers.get("anthropic");
  const openai = data.allTime.providers.get("openai");
  assert.equal(anthropic.messages, 2);
  assert.equal(anthropic.cost, 3);
  assert.equal(anthropic.models.get("claude-fable-5").messages, 2);
  assert.equal(openai.messages, 1);
  assert.equal(openai.cost, 4);
});

test("dedupes copied stable entries but preserves independent and conflicting identities", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const sameTimestamp = TS_TODAY + 42;
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[sessionLine("session-a", sameTimestamp), assistantLine({ id: "entry-a", ts: sameTimestamp, cost: 1 })].join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, "b.jsonl"),
    `${[sessionLine("session-b", sameTimestamp), assistantLine({ id: "entry-a", ts: sameTimestamp, cost: 1 })].join("\n")}\n`,
  );
  // A copied branch keeps the entry id and is counted once.
  writeFileSync(
    join(sessionsDir, "copy.jsonl"),
    `${[sessionLine("session-copy", sameTimestamp, "/tmp", join(sessionsDir, "a.jsonl")), assistantLine({ id: "entry-a", ts: sameTimestamp, cost: 1 })].join("\n")}\n`,
  );
  // Reused ids with conflicting accounting are not assumed to be a copy.
  writeFileSync(
    join(sessionsDir, "conflict-a.jsonl"),
    `${[sessionLine("session-conflict-a", sameTimestamp), assistantLine({ id: "entry-conflict", ts: sameTimestamp, cost: 2 })].join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, "conflict-b.jsonl"),
    `${[sessionLine("session-conflict-b", sameTimestamp), assistantLine({ id: "entry-conflict", ts: sameTimestamp, cost: 3 })].join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, "conflict-copy.jsonl"),
    `${[sessionLine("session-conflict-copy", sameTimestamp, "/tmp", join(sessionsDir, "conflict-b.jsonl")), assistantLine({ id: "entry-conflict", ts: sameTimestamp, cost: 3 })].join("\n")}\n`,
  );
  // Legacy lines without an id are scoped to their own session file.
  writeFileSync(
    join(sessionsDir, "legacy-a.jsonl"),
    `${[sessionLine("legacy-a", sameTimestamp), assistantLine({ id: "", ts: sameTimestamp, cost: 4 })].join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, "legacy-b.jsonl"),
    `${[sessionLine("legacy-b", sameTimestamp), assistantLine({ id: "", ts: sameTimestamp, cost: 4 })].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.allTime.totals.cost, 1 + 1 + 2 + 3 + 4 + 4);
  assert.equal(data.allTime.totals.messages, 6);
});
test("collectUsageData includes tool and summary usage without inflating assistant message counts", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(
    join(sessionsDir, "auxiliary.jsonl"),
    `${[
      sessionLine("s1", TS_TODAY, "/projects/auxiliary"),
      assistantLine({ ts: TS_TODAY, cost: 1, input: 10, output: 1, reasoning: 1 }),
      toolResultLine({
        id: "tool-a",
        ts: TS_TODAY + 1000,
        cost: 2,
        input: 20,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        reasoning: 2,
      }),
      compactionLine({ id: "compact-a", ts: TS_TODAY + 2000, cost: 3, input: 30, output: 3 }),
      branchSummaryLine({ id: "branch-a", ts: TS_TODAY + 3000, cost: 4, input: 40, output: 4 }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.ok(data);
  assert.equal(data.today.totals.cost, 10);
  assert.equal(data.today.totals.messages, 1, "Msgs remains an assistant-message count");
  assert.equal(data.today.totals.sessions, 1);
  assert.equal(data.today.totals.tokens.total, 11 + 26 + 33 + 44);
  assert.equal(data.today.totals.tokens.cacheRead, 3);

  const auxiliary = data.today.providers.get("Tools");
  assert.ok(auxiliary);
  assert.equal(auxiliary.cost, 9);
  assert.equal(auxiliary.messages, 0);
  assert.equal(auxiliary.sessions.size, 1);
  assert.equal(auxiliary.models.get("summaries").cost, 9);
  assert.equal(auxiliary.models.get("summaries").messages, 0);

  const hourMs = 3_600_000;
  const bucket = data.hourly.get(Math.floor(TS_TODAY / hourMs) * hourMs);
  const auxiliaryCell = bucket.get("Tools\u0000summaries\u0000Tools/summaries");
  assert.equal(auxiliaryCell.cost, 9);
  assert.equal(auxiliaryCell.messages, 0);
  assert.equal(auxiliaryCell.reasoning, 2);

  const overhead = findInsight(data, "today", /usage reported by tools and conversation summaries/);
  assert.ok(overhead);
  assert.equal(overhead.kind, "structure");
  assert.equal(overhead.stat, "90%");
});

test("collectUsageData counts cache warming once across copied history and a warm cache", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const original = join(sessionsDir, "original.jsonl");
  const copy = join(sessionsDir, "copy.jsonl");
  const warm = usageEntryLine({
    id: "shared-warm",
    ts: TS_TODAY + 1000,
    cost: 0.25,
    input: 0,
    output: 0,
    cacheRead: 50_000,
  });
  const sameAmountDifferentCall = usageEntryLine({
    id: "second-warm",
    ts: TS_TODAY + 1000,
    cost: 0.25,
    input: 0,
    output: 0,
    cacheRead: 50_000,
  });
  writeFileSync(original, `${[sessionLine("original", TS_TODAY), warm].join("\n")}\n`);
  writeFileSync(
    copy,
    `${[sessionLine("copy", TS_TODAY, "/tmp", original), warm, sameAmountDifferentCall].join("\n")}\n`,
  );

  for (const filesToParse of [2, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.cost, 0.5, "the copied entry dedupes, but a distinct identical call survives");
    assert.equal(data.today.totals.messages, 0, "standalone usage is not an assistant message");
    assert.equal(data.today.totals.sessions, 1, "only the file with unique usage contributes after dedupe");
    assert.equal(data.today.totals.tokens.cacheRead, 100_000);
    assert.equal(data.today.totals.tokens.total, 0, "cached tokens are not fresh tokens");
    const provider = data.today.providers.get("anthropic");
    assert.equal(provider.cost, 0.5);
    assert.equal(provider.messages, 0);
    assert.equal(provider.models.get("claude-fable-5").cost, 0.5);
    assert.equal(data.today.providers.has("Tools"), false);
    const bucket = data.hourly.get(Math.floor(TS_TODAY / 3_600_000) * 3_600_000);
    assert.equal(bucket.get("anthropic\u0000claude-fable-5\u0000").cost, 0.5);
    assert.equal(bucket.get("anthropic\u0000claude-fable-5\u0000").messages, 0);
  }
});

test("collectUsageData suppresses canonical tool usage already present in a linked child session", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const parentPath = join(sessionsDir, "parent.jsonl");
  const childPath = join(sessionsDir, "parent", "run-a", "run-0", "session.jsonl");
  mkdirSync(join(childPath, ".."), { recursive: true });
  writeFileSync(
    childPath,
    `${[
      sessionLine("child", TS_TODAY),
      assistantLine({ ts: TS_TODAY + 1000, cost: 3, input: 30, output: 3, cacheRead: 4 }),
    ].join("\n")}\n`,
  );
  writeFileSync(
    parentPath,
    `${[
      sessionLine("parent", TS_TODAY),
      nestedToolResultLine({
        id: "reported-child",
        ts: TS_TODAY + 2000,
        reported: { cost: 3, input: 30, output: 3, cacheRead: 4 },
        children: [
          {
            cost: 3,
            input: 30,
            output: 3,
            cacheRead: 4,
            sessionFile: childPath,
            // Old pi-subagents records retained messages before direct child usage.
            // The large-line parser must skip this nested usage rather than select it.
            messages: [{ role: "assistant", usage: usage({ cost: 99, input: 99, output: 99 }) }],
          },
        ],
        content: "x".repeat(70 * 1024), // exercise the allocation-safe large-line parser
      }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.today.totals.cost, 3);
  assert.equal(data.today.totals.messages, 1);
  assert.equal(data.today.totals.sessions, 1, "the empty parent must not become a second contributing session");
  assert.equal(data.today.providers.has("Tools"), false);
});

test("collectUsageData counts the full aggregate when any child session is missing", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const parentPath = join(sessionsDir, "mixed.jsonl");
  const childPath = join(sessionsDir, "mixed", "run-a", "run-0", "session.jsonl");
  mkdirSync(join(childPath, ".."), { recursive: true });
  writeFileSync(
    childPath,
    `${[
      sessionLine("child", TS_TODAY),
      assistantLine({ ts: TS_TODAY + 1000, cost: 2, input: 20, output: 2, reasoning: 2 }),
    ].join("\n")}\n`,
  );
  writeFileSync(
    parentPath,
    `${[
      sessionLine("parent", TS_TODAY),
      nestedToolResultLine({
        id: "mixed-children",
        ts: TS_TODAY + 2000,
        reported: { cost: 5, input: 50, output: 5, reasoning: 5 },
        children: [
          { cost: 2, input: 20, output: 2, reasoning: 2 }, // resolved through the standard derived path
          { cost: 3, input: 30, output: 3, reasoning: 3, sessionFile: join(sessionsDir, "missing.jsonl") },
        ],
      }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  // One child is missing, so the $5 aggregate is counted whole next to the
  // scanned $2 child — a deliberate small overcount instead of residual math.
  assert.equal(data.today.totals.cost, 7);
  assert.equal(data.today.totals.messages, 1);
  assert.equal(data.today.providers.get("anthropic").cost, 2);
  assert.equal(data.today.providers.get("Tools").cost, 5);
  assert.equal(data.today.providers.get("Tools").models.get("summaries").cost, 5);
});

test("collectUsageData backfills legacy nested usage only when no scanned child session represents it", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const parentPath = join(sessionsDir, "legacy.jsonl");
  const childPath = join(sessionsDir, "legacy", "run-a", "run-0", "session.jsonl");
  mkdirSync(join(childPath, ".."), { recursive: true });
  writeFileSync(
    childPath,
    `${[
      sessionLine("child", TS_TODAY),
      assistantLine({ ts: TS_TODAY + 1000, cost: 7, input: 70, output: 7 }),
      assistantLine({ ts: TS_TODAY + 2000, cost: 2, input: 20, output: 2 }),
      assistantLine({ ts: TS_TODAY + 3000, cost: 8, input: 80, output: 8 }),
    ].join("\n")}\n`,
  );
  writeFileSync(
    parentPath,
    `${[
      sessionLine("parent", TS_TODAY),
      nestedToolResultLine({
        id: "legacy-children",
        ts: TS_TODAY + 4000,
        children: [
          { cost: 2, input: 20, output: 2 }, // exact middle span in the derived child session
          { cost: 3, input: 30, output: 3, sessionFile: join(sessionsDir, "gone.jsonl") },
        ],
      }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.today.totals.cost, 20, "$17 in the child session plus only the missing $3 legacy result");
  assert.equal(data.today.totals.messages, 3);
  assert.equal(data.today.providers.get("Tools").cost, 3);
});

test("collectUsageData trusts scanned child sessions over their reported usage", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const childPath = join(sessionsDir, "exact-child.jsonl");
  writeFileSync(
    childPath,
    [sessionLine("child", TS_TODAY), assistantLine({ ts: TS_TODAY + 1000, cost: 2, input: 20, output: 2 })].join("\n") +
      "\n",
  );
  writeFileSync(
    join(sessionsDir, "parent.jsonl"),
    `${[
      sessionLine("parent", TS_TODAY),
      nestedToolResultLine({
        id: "near-not-exact",
        ts: TS_TODAY + 2000,
        children: [{ cost: 2.000001, input: 20, output: 2, sessionFile: childPath }],
      }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  // The child session file exists, so it is the record — the reported child
  // usage is skipped even though rounding noise makes the vectors differ.
  assert.equal(data.today.totals.cost, 2);
  assert.equal(data.today.providers.has("Tools"), false);
});

test("collectUsageData dedupes copied legacy child reports by parent entry id", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const copied = nestedToolResultLine({
    id: "copied-legacy",
    ts: TS_TODAY,
    children: [{ cost: 3, input: 30, output: 3, sessionFile: join(sessionsDir, "missing.jsonl") }],
  });
  writeFileSync(join(sessionsDir, "a.jsonl"), `${[sessionLine("s1", TS_TODAY), copied].join("\n")}\n`);
  writeFileSync(
    join(sessionsDir, "b.jsonl"),
    `${[sessionLine("s2", TS_TODAY, "/tmp", join(sessionsDir, "a.jsonl")), copied].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.today.totals.cost, 3);
  assert.equal(data.today.totals.messages, 0);
  assert.equal(data.today.providers.get("Tools").cost, 3);
});

test("collectUsageData suppresses copied tool reports when any copy resolves its children", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const childPath = join(sessionsDir, "child.jsonl");
  writeFileSync(
    childPath,
    [sessionLine("child", TS_TODAY), assistantLine({ ts: TS_TODAY + 1000, cost: 3, input: 30, output: 3 })].join("\n") +
      "\n",
  );
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[
      sessionLine("a", TS_TODAY),
      nestedToolResultLine({
        id: "copied-linked",
        ts: TS_TODAY + 2000,
        reported: { cost: 3, input: 30, output: 3 },
        children: [{ cost: 3, input: 30, output: 3, sessionFile: join(sessionsDir, "missing.jsonl") }],
      }),
    ].join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, "b.jsonl"),
    `${[
      sessionLine("b", TS_TODAY, "/tmp", join(sessionsDir, "a.jsonl")),
      nestedToolResultLine({
        id: "copied-linked",
        ts: TS_TODAY + 2000,
        reported: { cost: 3, input: 30, output: 3 },
        children: [{ cost: 3, input: 30, output: 3, sessionFile: childPath }],
      }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.today.totals.cost, 3);
  assert.equal(data.today.totals.messages, 1);
  assert.equal(data.today.providers.has("Tools"), false);
});

test("collectUsageData dedupes copied auxiliary entries by id without collapsing parallel peers", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const copied = toolResultLine({ id: "copied-tool", ts: TS_TODAY, cost: 2, input: 20, output: 2 });
  const parallel = toolResultLine({ id: "parallel-tool", ts: TS_TODAY, cost: 2, input: 20, output: 2 });
  writeFileSync(join(sessionsDir, "a.jsonl"), `${[sessionLine("s1", TS_TODAY), copied].join("\n")}\n`);
  writeFileSync(
    join(sessionsDir, "b.jsonl"),
    `${[sessionLine("s2", TS_TODAY, "/tmp", join(sessionsDir, "a.jsonl")), copied, parallel].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.today.totals.cost, 4, "one copied entry plus one distinct parallel entry");
  assert.equal(data.today.totals.messages, 0);
  assert.equal(data.today.totals.sessions, 2);
  assert.equal(data.today.providers.get("Tools").models.get("summaries").cost, 4);
  assert.equal(findInsight(data, "today", /usage reported by tools and conversation summaries/).stat, "100%");
});

test("collectUsageData buckets the rolling 30-day window from midnight 29 days back", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[
      sessionLine("s1", TS_OLD),
      assistantLine({ ts: TS_30D_EDGE_OUT, cost: 1 }), // outside — allTime only
      assistantLine({ ts: TS_30D_EDGE_IN, cost: 2 }), // first instant inside the window
      assistantLine({ ts: TS_LAST_WEEK, cost: 4 }), // last week is also within 30 days
      assistantLine({ ts: TS_TODAY, cost: 8 }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.allTime.totals.messages, 4);
  assert.equal(data.last30Days.totals.messages, 3);
  assert.equal(data.last30Days.totals.cost, 14);
  assert.equal(data.last30Days.totals.sessions, 1);
  // The 30-day window overlaps but does not replace the week buckets.
  assert.equal(data.lastWeek.totals.cost, 4);
  assert.equal(data.today.totals.cost, 8);
});

test("collectUsageData ignores files without a session header", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(join(sessionsDir, "headerless.jsonl"), `${assistantLine({ ts: TS_TODAY, cost: 5 })}\n`);
  writeFileSync(
    join(sessionsDir, "normal.jsonl"),
    `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY + 5000, cost: 1 })].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.allTime.totals.messages, 1);
  assert.equal(data.allTime.totals.cost, 1);
});

test("collectUsageData returns null when aborted", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY })].join("\n")}\n`,
  );
  const controller = new AbortController();
  controller.abort();
  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, signal: controller.signal });
  assert.equal(data, null);
});

test("collectUsageData forwards cancellation into the initial cache decode", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const prior = JSON.stringify({
    version: 11,
    names: ["provider", "model", "thinking", "source"],
    files: {
      [join(sessionsDir, "cached.jsonl")]: {
        size: 1,
        mtimeMs: 1,
        sessionId: "cached",
        cwd: "/tmp",
        parentSession: "",
        messages: Array.from({ length: 100 }, () => [0, 1, 1, 2, 3, 4, 5, 6, 2, 0, 0, 0, 3, 0, 0, -1, 0, -1]),
        toolUsages: [],
      },
    },
  });
  writeFileSync(cachePath, prior);
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let decodeChecks = 0;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value: () => {
      if (++decodeChecks === 40) controller.abort();
      check();
    },
  });
  let progressReported = false;
  const data = await collectUsageData({
    sessionsDir,
    cachePath,
    now: NOW,
    signal: controller.signal,
    onProgress: () => {
      progressReported = true;
    },
  });
  assert.equal(data, null);
  assert.ok(decodeChecks >= 40, "initial cache load checks abort inside its tuple loop");
  assert.equal(progressReported, false, "scan stops before parsing or reporting a cache rebuild");
  assert.equal(readFileSync(cachePath, "utf8"), prior);
  assert.equal(existsSync(`${cachePath}.lock`), false);
});

test("collectUsageData aborts a blocked cache save without leaving a waiter or later write", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY, cost: 1 })].join("\n")}\n`,
  );
  const controller = new AbortController();
  const lockPath = `${cachePath}.lock`;
  t.after(() => rmSync(lockPath, { force: true }));
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => clearTimeout(abortTimer));
  const started = Date.now();
  const data = await collectUsageData({
    sessionsDir,
    cachePath,
    now: NOW,
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.filesParsed !== 1) return;
      writeFileSync(lockPath, "held by another scanner");
      abortTimer = setTimeout(() => controller.abort(), 40);
    },
  });
  assert.equal(data, null);
  assert.ok(Date.now() - started < 1_000, "worker settles on abort, not the five-second lock timeout");
  assert.equal(existsSync(lockPath), true, "the other scanner still owns its lock");
  assert.equal(existsSync(cachePath), false);
  rmSync(lockPath);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(cachePath), false, "aborted save cannot write after the lock becomes free");
});

test("collectUsageData skips partial cache writes on cancellation even with a free lock", async (t) => {
  const { root, sessionsDir, cachePath } = fixture(t);
  for (let i = 0; i < 101; i++) {
    writeFileSync(join(sessionsDir, `${String(i).padStart(3, "0")}.jsonl`), `${sessionLine(`s${i}`, TS_TODAY)}\n`);
  }
  // The initial load happens before cancellation; the old partial-save path
  // unnecessarily re-read and serialized this large cache after cancellation.
  const prior = JSON.stringify({ version: 11, names: [], files: {}, padding: "x".repeat(22 * 1024 * 1024) });
  writeFileSync(cachePath, prior);
  const controller = new AbortController();
  let cancelledAt = 0;
  const data = await collectUsageData({
    sessionsDir,
    cachePath,
    now: NOW,
    parseConcurrency: 1,
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.filesParsed === 100) {
        cancelledAt = Date.now();
        controller.abort();
      }
    },
  });
  assert.equal(data, null);
  assert.ok(Date.now() - cancelledAt < 500, "cancelled scan does not perform a second large cache read/write");
  assert.equal(readFileSync(cachePath, "utf8"), prior);
  assert.equal(existsSync(`${cachePath}.lock`), false);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("collectUsageData skips locked partial cache warm instead of waiting to write after cancellation", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  for (let i = 0; i < 101; i++) {
    writeFileSync(join(sessionsDir, `${String(i).padStart(3, "0")}.jsonl`), `${sessionLine(`s${i}`, TS_TODAY)}\n`);
  }
  const controller = new AbortController();
  const lockPath = `${cachePath}.lock`;
  t.after(() => rmSync(lockPath, { force: true }));
  let lockHeldAt = 0;
  const data = await collectUsageData({
    sessionsDir,
    cachePath,
    now: NOW,
    parseConcurrency: 1,
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.filesParsed !== 100) return;
      writeFileSync(lockPath, "held by another scanner");
      lockHeldAt = Date.now();
      controller.abort();
    },
  });
  assert.equal(data, null);
  assert.ok(Date.now() - lockHeldAt < 1_000, "cancelled warm only tries the lock once");
  assert.equal(existsSync(cachePath), false);
  rmSync(lockPath);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(existsSync(cachePath), false, "no orphan waiter writes after returning");
});

// =============================================================================
// collectUsageData — caching
// =============================================================================

test("collectUsageData reuses the cache for unchanged files and invalidates on change", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const filePath = join(sessionsDir, "a.jsonl");
  writeFileSync(filePath, `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY, cost: 1 })].join("\n")}\n`);

  const first = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(first.allTime.totals.cost, 1);
  assert.ok(existsSync(cachePath));

  // Poison the cached cost. If the next run serves from cache (no reparse),
  // the poisoned value shows up in the totals.
  const cacheJson = JSON.parse(readFileSync(cachePath, "utf8"));
  cacheJson.files[filePath].messages[0][2] = 999;
  writeFileSync(cachePath, JSON.stringify(cacheJson));

  const second = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(second.allTime.totals.cost, 999, "unchanged file should be served from cache");

  // Appending to the file changes its size → cache entry invalidated → reparse.
  appendFileSync(filePath, `${assistantLine({ ts: TS_TODAY + 60_000, cost: 2 })}\n`);
  const third = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(third.allTime.totals.cost, 3, "changed file should be reparsed from disk");
  assert.equal(third.allTime.totals.messages, 2);

  // And the reparse refreshed the cache: poison is gone.
  const refreshed = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(refreshed.files[filePath].messages[0][2], 1);
});

test("collectUsageData evicts cache entries for deleted files", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const keepPath = join(sessionsDir, "keep.jsonl");
  const dropPath = join(sessionsDir, "drop.jsonl");
  writeFileSync(keepPath, `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY, cost: 1 })].join("\n")}\n`);
  writeFileSync(
    dropPath,
    `${[sessionLine("s2", TS_TODAY), assistantLine({ ts: TS_TODAY + 1000, cost: 10 })].join("\n")}\n`,
  );

  const first = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(first.allTime.totals.cost, 11);

  rmSync(dropPath);
  const second = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(second.allTime.totals.cost, 1);

  const cacheJson = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.ok(cacheJson.files[keepPath]);
  assert.equal(cacheJson.files[dropPath], undefined);
});

test("collectUsageData survives a corrupt cache file", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY, cost: 1 })].join("\n")}\n`,
  );
  writeFileSync(cachePath, "definitely not json {");

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.allTime.totals.cost, 1);

  // Cache was rebuilt.
  const cacheJson = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(cacheJson.version, 11);
});

test("collectUsageData works with the cache disabled", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY, cost: 1 })].join("\n")}\n`,
  );
  const data = await collectUsageData({ sessionsDir, cachePath: null, now: NOW });
  assert.equal(data.allTime.totals.cost, 1);
  assert.equal(existsSync(cachePath), false);
});

// =============================================================================
// Cache round-trip
// =============================================================================

test("saveUsageCache/loadUsageCache round-trips file states", async (t) => {
  const { root } = fixture(t);
  const cachePath = join(root, "roundtrip.json");
  const states = new Map([
    [
      "/tmp/a.jsonl",
      {
        size: 123,
        mtimeMs: 456.789,
        parsed: {
          sessionId: "s1",
          cwd: "/home/u/projects/x",
          parentSession: "",
          messages: [
            {
              provider: "anthropic",
              model: "claude-fable-5",
              responseModel: "claude-fable-5-20260930",
              thinkingLevel: "xhigh",
              source: "assistant",
              sourceId: "assistant-a",
              cost: 1.5,
              input: 10,
              output: 20,
              cacheRead: 30,
              cacheWrite: 40,
              reasoning: 7,
              timestamp: TS_TODAY,
              afterCompaction: true,
              afterContextEdit: true,
              previousAssistantId: "earlier-assistant",
              branchWarmAt: TS_TODAY - 1000,
            },
            {
              provider: "anthropic",
              model: "claude-fable-5",
              thinkingLevel: "xhigh",
              source: "usage",
              sourceId: "warm-a",
              cost: 0.25,
              input: 0,
              output: 0,
              cacheRead: 50_000,
              cacheWrite: 0,
              reasoning: 0,
              timestamp: TS_TODAY + 1,
              afterCompaction: false,
              cacheWarm: true,
            },
            {
              provider: "Tools",
              model: "summaries",
              thinkingLevel: "Tools/summaries",
              source: "auxiliary",
              sourceId: "summary-a",
              cost: 0.25,
              input: 1,
              output: 2,
              cacheRead: 3,
              cacheWrite: 4,
              reasoning: 0,
              timestamp: TS_OLD,
              afterCompaction: false,
            },
          ],
          toolUsages: [
            {
              sourceId: "tool-a",
              timestamp: TS_TODAY,
              reportedUsage: { cost: 2, input: 20, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1 },
              runId: "run-a",
              children: [
                {
                  resultIndex: 0,
                  sessionFile: "/tmp/child.jsonl",
                  usage: { cost: 2, input: 20, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 0 },
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "/tmp/empty.jsonl",
      { size: 1, mtimeMs: 2, parsed: { sessionId: "", cwd: "", parentSession: "", messages: [], toolUsages: [] } },
    ],
  ]);

  await saveUsageCache(cachePath, states);
  const loaded = await loadUsageCache(cachePath);

  assert.equal(loaded.size, 2);
  const a = loaded.get("/tmp/a.jsonl");
  assert.equal(a.size, 123);
  assert.equal(a.mtimeMs, 456.789);
  assert.equal(a.parsed.sessionId, "s1");
  assert.equal(a.parsed.cwd, "/home/u/projects/x");
  assert.deepEqual(a.parsed.messages, states.get("/tmp/a.jsonl").parsed.messages);
  assert.deepEqual(a.parsed.toolUsages, states.get("/tmp/a.jsonl").parsed.toolUsages);
  assert.equal(loaded.get("/tmp/empty.jsonl").parsed.sessionId, "");
});

test("concurrent cache saves preserve still-current files from both scanners", async (t) => {
  const { root } = fixture(t);
  const cachePath = join(root, "concurrent.json");
  const fileA = join(root, "a.jsonl");
  const fileB = join(root, "b.jsonl");
  writeFileSync(fileA, "a");
  writeFileSync(fileB, "b");

  const stateFor = (filePath: string, sessionId: string): CachedFileState => {
    const file = statSync(filePath);
    return {
      size: file.size,
      mtimeMs: file.mtimeMs,
      parsed: { sessionId, cwd: "/tmp", parentSession: "", messages: [], toolUsages: [] },
    };
  };
  await Promise.all([
    saveUsageCache(cachePath, new Map([[fileA, stateFor(fileA, "session-a")]])),
    saveUsageCache(cachePath, new Map([[fileB, stateFor(fileB, "session-b")]])),
  ]);

  const loaded = await loadUsageCache(cachePath);
  assert.equal(loaded.get(fileA)?.parsed.sessionId, "session-a");
  assert.equal(loaded.get(fileB)?.parsed.sessionId, "session-b");
});

test("A/B/C saves serialize even after A's lock appears older than 30 seconds", async (t) => {
  const { root, cachePath } = fixture(t);
  const paths = ["a", "b", "c"].map((name) => join(root, `${name}.jsonl`));
  for (const path of paths) writeFileSync(path, path);
  const state = (path: string): CachedFileState => {
    const st = statSync(path);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      parsed: { sessionId: path, cwd: "/tmp", parentSession: "", messages: [], toolUsages: [] },
    };
  };
  const clock = Date.now;
  let clockOffset = 0;
  Date.now = () => clock() + clockOffset;
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let b: Promise<void> | undefined;
  let c: Promise<void> | undefined;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value: () => {
      if (!b && existsSync(`${cachePath}.lock`)) {
        // Writer A is inside the critical section; make its lock look old
        // before B and C begin their writes, without waiting 30 real seconds.
        clockOffset += 31_000;
        const waitLimit = AbortSignal.timeout(2_000);
        b = saveUsageCache(cachePath, new Map([[paths[1], state(paths[1])]]), { signal: waitLimit });
        c = saveUsageCache(cachePath, new Map([[paths[2], state(paths[2])]]), { signal: waitLimit });
      }
      check();
    },
  });
  try {
    await saveUsageCache(cachePath, new Map([[paths[0], state(paths[0])]]), { signal: controller.signal });
    assert.ok(b && c, "B and C start while A holds its lock");
    await Promise.all([b, c]);
    const loaded = await loadUsageCache(cachePath);
    assert.deepEqual(
      paths.map((path) => loaded.get(path)?.parsed.sessionId),
      paths,
      "all three writes survive the lock handoffs",
    );
    assert.equal(existsSync(`${cachePath}.lock`), false);
  } finally {
    Date.now = clock;
  }
});

test("release does not unlink a manually replaced successor lock", async (t) => {
  const { root, cachePath } = fixture(t);
  const lockPath = `${cachePath}.lock`;
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let replaced = false;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value: () => {
      if (!replaced && existsSync(lockPath)) {
        replaced = true;
        unlinkSync(lockPath);
        writeFileSync(lockPath, "replacement owner");
      }
      check();
    },
  });
  const fileA = join(root, "a.jsonl");
  writeFileSync(fileA, "a");
  const st = statSync(fileA);
  const state: CachedFileState = {
    size: st.size,
    mtimeMs: st.mtimeMs,
    parsed: { sessionId: "A", cwd: "/tmp", parentSession: "", messages: [], toolUsages: [] },
  };
  await saveUsageCache(cachePath, new Map([[fileA, state]]), { signal: controller.signal });
  assert.equal(replaced, true);
  assert.equal(readFileSync(lockPath, "utf8"), "replacement owner");
  await saveUsageCache(cachePath, new Map(), { waitForLock: false });
  assert.equal(readFileSync(lockPath, "utf8"), "replacement owner");
  unlinkSync(lockPath);
  await saveUsageCache(cachePath, new Map());
  assert.equal((await loadUsageCache(cachePath)).get(fileA)?.parsed.sessionId, "A");
});

test("abort after cache lock acquisition removes the temporary file and leaves prior cache intact", async (t) => {
  const { root, cachePath } = fixture(t);
  const state = (sessionId: string): CachedFileState => ({
    size: 1,
    mtimeMs: 1,
    parsed: { sessionId, cwd: "/tmp", parentSession: "", messages: [], toolUsages: [] },
  });
  await saveUsageCache(cachePath, new Map([["/tmp/old.jsonl", state("old")]]));
  const prior = readFileSync(cachePath, "utf8");
  const controller = new AbortController();
  const originalCheck = controller.signal.throwIfAborted.bind(controller.signal);
  let cancelledAfterTemp = false;
  // Trigger cancellation at the post-write checkpoint, while both the lock
  // and completed temporary file exist, without relying on filesystem timing.
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value: () => {
      if (readdirSync(root).some((name) => name.startsWith(".usage-cache-") && name.endsWith(".tmp"))) {
        assert.equal(existsSync(`${cachePath}.lock`), true);
        cancelledAfterTemp = true;
        controller.abort();
      }
      originalCheck();
    },
  });
  await assert.rejects(
    saveUsageCache(cachePath, new Map([["/tmp/new.jsonl", state("new")]]), { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(cancelledAfterTemp, true);
  assert.equal(readFileSync(cachePath, "utf8"), prior);
  assert.equal(existsSync(`${cachePath}.lock`), false);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("abort during locked cache read releases lock without a late write", async (t) => {
  const { root, cachePath } = fixture(t);
  const prior = JSON.stringify({ version: 11, names: [], files: {}, padding: "x".repeat(22 * 1024 * 1024) });
  writeFileSync(cachePath, prior);
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let lockedChecks = 0;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value: () => {
      if (existsSync(`${cachePath}.lock`) && ++lockedChecks === 3) controller.abort();
      check();
    },
  });
  await assert.rejects(saveUsageCache(cachePath, new Map(), { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.ok(lockedChecks >= 3, "cancellation reaches the post-read checkpoint under the lock");
  assert.equal(existsSync(`${cachePath}.lock`), false);
  assert.equal(readFileSync(cachePath, "utf8"), prior);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readFileSync(cachePath, "utf8"), prior, "no continuation writes after rejection");
});

test("abort during cache tuple decoding releases the lock", async (t) => {
  const { root, cachePath } = fixture(t);
  const filePath = join(root, "source.jsonl");
  const tuple = [0, 1, 1, 2, 3, 4, 5, 6, 2, 0, 0, 0, 3, 0, 0, -1, 0, -1];
  const prior = JSON.stringify({
    version: 11,
    names: ["provider", "model", "thinking", "source"],
    files: {
      [filePath]: {
        size: 1,
        mtimeMs: 1,
        sessionId: "session",
        cwd: "/tmp",
        parentSession: "",
        messages: Array.from({ length: 100 }, () => tuple),
        toolUsages: [],
      },
    },
  });
  writeFileSync(cachePath, prior);
  const controller = new AbortController();
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let lockedChecks = 0;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    value: () => {
      if (existsSync(`${cachePath}.lock`) && ++lockedChecks === 40) controller.abort();
      check();
    },
  });
  await assert.rejects(saveUsageCache(cachePath, new Map(), { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.ok(lockedChecks >= 40, "abort occurred inside the tuple loop");
  assert.equal(existsSync(`${cachePath}.lock`), false);
  assert.equal(readFileSync(cachePath, "utf8"), prior);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("an old lock is not stolen; timeout explains manual recovery", async (t) => {
  const { cachePath } = fixture(t);
  const lockPath = `${cachePath}.lock`;
  writeFileSync(lockPath, "orphaned lock");
  const actualNow = Date.now;
  const clock = actualNow();
  const stale = new Date(clock - 31_000);
  utimesSync(lockPath, stale, stale);
  let elapsed = 0;
  Date.now = () => {
    elapsed += 1_000;
    return clock + elapsed;
  };
  try {
    await assert.rejects(saveUsageCache(cachePath, new Map()), (error: Error) => {
      assert.match(error.message, /usage cache lock busy/);
      assert.ok(error.message.includes(lockPath));
      assert.match(error.message, /no \/usage writer is active.*remove this orphaned lock manually/);
      return true;
    });
  } finally {
    Date.now = actualNow;
  }
  assert.equal(readFileSync(lockPath, "utf8"), "orphaned lock");
  assert.equal(existsSync(cachePath), false);
});

test("a matching v7 cache rebuilds to ingest previously omitted standalone usage", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const filePath = join(sessionsDir, "old.jsonl");
  writeFileSync(
    filePath,
    `${[
      sessionLine("old", TS_TODAY),
      assistantLine({ id: "a", ts: TS_TODAY, cost: 1 }),
      usageEntryLine({ id: "warm", ts: TS_TODAY + 1000, cost: 2 }),
    ].join("\n")}\n`,
  );
  const file = statSync(filePath);
  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 7,
      names: ["anthropic", "claude-fable-5", "", "a"],
      files: {
        [filePath]: {
          size: file.size,
          mtimeMs: file.mtimeMs,
          sessionId: "old",
          cwd: "/tmp",
          parentSession: "",
          messages: [[0, 1, 1, 100, 50, 0, 0, TS_TODAY, 2, 0, 0, 0, 3]],
          toolUsages: [],
        },
      },
    }),
  );

  const progress = [];
  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
  assert.equal(progress[0].mode, "rebuild");
  assert.equal(progress[0].filesToParse, 1);
  assert.equal(data.today.totals.cost, 3);
  assert.equal(data.today.totals.messages, 1);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 11);
  assert.equal((await loadUsageCache(cachePath)).get(filePath)?.parsed.messages[1].source, "usage");
});

test("a matching v9 cache rebuilds branch-aware TTL metadata", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const filePath = join(sessionsDir, "old.jsonl");
  writeFileSync(
    filePath,
    `${[
      sessionLine("old", TS_TODAY),
      assistantLine({ id: "first", ts: TS_TODAY, input: 1000, cacheRead: 100_000 }),
      usageEntryLine({ id: "warm", parentId: "first", ts: TS_TODAY + 4.5 * 60_000, cost: 0.5 }),
      assistantLine({ id: "sibling", parentId: "first", ts: TS_TODAY + 6 * 60_000, cost: 5, input: 100_000 }),
    ].join("\n")}\n`,
  );
  const file = statSync(filePath);
  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 9,
      names: ["anthropic", "claude-fable-5", "", "first", "warm", "sibling"],
      files: {
        [filePath]: {
          size: file.size,
          mtimeMs: file.mtimeMs,
          sessionId: "old",
          cwd: "/tmp",
          parentSession: "",
          messages: [
            [0, 1, 1, 1000, 50, 100_000, 0, TS_TODAY, 2, 0, 0, 0, 3, 0, 0],
            [0, 1, 0.5, 100, 50, 0, 0, TS_TODAY + 4.5 * 60_000, 2, 0, 0, 2, 4, 0, 1],
            [0, 1, 5, 100_000, 50, 0, 0, TS_TODAY + 6 * 60_000, 2, 0, 0, 0, 5, 0, 0],
          ],
          toolUsages: [],
        },
      },
    }),
  );
  const progress = [];
  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
  assert.equal(progress[0].mode, "rebuild");
  assert.equal(progress[0].filesToParse, 1);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 11);
  assert.equal(findInsight(data, "today", /resuming conversations after a break/).stat, "$5.00");
  assert.equal((await loadUsageCache(cachePath)).get(filePath)?.parsed.messages.at(-1)?.previousAssistantId, "first");
});

test("a matching v10 cache rebuilds concrete-model and zero-warm timing metadata", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const filePath = join(sessionsDir, "v10.jsonl");
  const concrete = "claude-fable-5-20260930";
  writeFileSync(
    filePath,
    `${[
      sessionLine("v10", TS_TODAY),
      assistantLine({ id: "first", ts: TS_TODAY, responseModel: concrete, input: 1000, cacheRead: 100_000 }),
      usageEntryLine({
        id: "zero-warm",
        parentId: "first",
        ts: TS_TODAY + 4.5 * 60_000,
        model: concrete,
        cost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
      }),
      assistantLine({
        id: "next",
        parentId: "zero-warm",
        ts: TS_TODAY + 6 * 60_000,
        responseModel: concrete,
        cost: 5,
        input: 100_000,
      }),
    ].join("\n")}\n`,
  );
  await collectUsageData({ sessionsDir, cachePath, now: NOW });
  const old = JSON.parse(readFileSync(cachePath, "utf8"));
  old.version = 10;
  old.files[filePath].messages = old.files[filePath].messages.map((tuple: number[]) => tuple.slice(0, 17));
  old.files[filePath].messages[1][2] = 99; // A false warm-cache hit would surface the poisoned cost.
  writeFileSync(cachePath, JSON.stringify(old));

  const progress = [];
  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
  assert.equal(progress[0].mode, "rebuild");
  assert.equal(progress[0].filesToParse, 1);
  assert.equal(data.today.totals.cost, 6);
  assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$5.00");
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 11);
  const messages = (await loadUsageCache(cachePath)).get(filePath)?.parsed.messages;
  assert.equal(messages?.[1].responseModel, concrete);
  assert.equal(messages?.[1].branchWarmAt, TS_TODAY + 4.5 * 60_000);
});

test("loadUsageCache rejects wrong versions and malformed entries", async (t) => {
  const { root } = fixture(t);
  const cachePath = join(root, "bad.json");

  writeFileSync(cachePath, JSON.stringify({ version: 999, names: [], files: {} }));
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  // v1 caches (pre-thinking-level) must be rejected wholesale, forcing a rebuild.
  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 1,
      names: ["p", "m"],
      files: { "/v1.jsonl": { size: 1, mtimeMs: 2, sessionId: "s", messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY]] } },
    }),
  );
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  // v2 caches (pre-cwd/compaction) must be rejected wholesale, forcing a rebuild.
  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 2,
      names: ["p", "m", "high"],
      files: {
        "/v2.jsonl": { size: 1, mtimeMs: 2, sessionId: "s", messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY, 2, 5]] },
      },
    }),
  );
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  // v3 caches predate tool/summary usage and must be rebuilt too.
  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 3,
      names: ["p", "m", "high"],
      files: {
        "/v3.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          cwd: "/w",
          messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY, 2, 5, 1]],
        },
      },
    }),
  );
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  // v4 caches have canonical tool usage but not the child-linkage metadata
  // needed to reconcile recursively scanned sessions.
  writeFileSync(cachePath, JSON.stringify({ version: 4, names: [], files: {} }));
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  // v7 cached records predate standalone usage and context-edit boundaries.
  writeFileSync(cachePath, JSON.stringify({ version: 7, names: [], files: {} }));
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  // v8's append-order edit markers and missing usage kind must be rebuilt.
  writeFileSync(cachePath, JSON.stringify({ version: 8, names: [], files: {} }));
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  // v9 did not retain branch-specific warm and previous-assistant ancestry.
  writeFileSync(cachePath, JSON.stringify({ version: 9, names: [], files: {} }));
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  // v10 lacks concrete response-model metadata and must be rebuilt.
  writeFileSync(cachePath, JSON.stringify({ version: 10, names: [], files: {} }));
  assert.equal((await loadUsageCache(cachePath)).size, 0);

  writeFileSync(
    cachePath,
    JSON.stringify({
      version: 11,
      names: ["p", "m", "high", "entry-a"],
      files: {
        "/ok.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          cwd: "/w",
          parentSession: "",
          messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY, 2, 5, 1, 1, 3, 1, 0, -1, 0, -1]],
          toolUsages: [],
        },
        "/bad-tuple.jsonl": { size: 1, mtimeMs: 2, sessionId: "s", cwd: "/w", messages: [[0, 1, 1]], toolUsages: [] },
        "/bad-name-idx.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          cwd: "/w",
          messages: [[7, 1, 1, 1, 1, 0, 0, TS_TODAY, 2, 0, 0, 0, 3, 0, 0, -1, 0, -1]],
          toolUsages: [],
        },
        "/bad-level-idx.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          cwd: "/w",
          messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY, 9, 0, 0, 0, 3, 0, 0, -1, 0, -1]],
          toolUsages: [],
        },
        "/bad-source.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          cwd: "/w",
          messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY, 2, 0, 0, 7, 3, 0, 0, -1, 0, -1]],
          toolUsages: [],
        },
        "/bad-source-id.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          cwd: "/w",
          messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY, 2, 0, 0, 0, 9, 0, 0, -1, 0, -1]],
          toolUsages: [],
        },
        "/bad-edit-marker.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          cwd: "/w",
          parentSession: "",
          messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY, 2, 0, 0, 0, 3, 7, 0, -1, 0, -1]],
          toolUsages: [],
        },
        "/bad-tool.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          cwd: "/w",
          messages: [],
          toolUsages: [[3, TS_TODAY, [1, 2], 3, []]],
        },
        "/no-cwd.jsonl": {
          size: 1,
          mtimeMs: 2,
          sessionId: "s",
          messages: [[0, 1, 1, 1, 1, 0, 0, TS_TODAY, 2, 0, 0, 0, 3, 0, 0, -1, 0, -1]],
          toolUsages: [],
        },
        "/bad-shape.jsonl": { size: "x", mtimeMs: 2, sessionId: "s", cwd: "/w", messages: [], toolUsages: [] },
      },
    }),
  );
  const loaded = await loadUsageCache(cachePath);
  assert.deepEqual([...loaded.keys()], ["/ok.jsonl"]);
  assert.equal(loaded.get("/ok.jsonl").parsed.messages[0].thinkingLevel, "high");
  assert.equal(loaded.get("/ok.jsonl").parsed.messages[0].reasoning, 5);
  assert.equal(loaded.get("/ok.jsonl").parsed.messages[0].afterCompaction, true);
  assert.equal(loaded.get("/ok.jsonl").parsed.messages[0].afterContextEdit, true);
  assert.equal(loaded.get("/ok.jsonl").parsed.messages[0].source, "auxiliary");
  assert.equal(loaded.get("/ok.jsonl").parsed.messages[0].sourceId, "entry-a");
  assert.equal(loaded.get("/ok.jsonl").parsed.cwd, "/w");
});

// =============================================================================
// Insights
// =============================================================================

const findInsight = (data, period, re) => data[period].insights.insights.find((i) => re.test(i.headline));

test("insights classify resume vs model-switch vs prefix misses and exclude compaction", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const SIX_MIN = 6 * 60_000;
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[
      sessionLine("s1", TS_TODAY),
      // Establishes a large previous context.
      assistantLine({ id: "first", ts: TS_TODAY, cost: 1, input: 1000, cacheRead: 100000 }),
      // Interleaved auxiliary usage must not replace the previous assistant or
      // dilute the percentages for assistant-turn/cache insights.
      toolResultLine({
        id: "nested-between-turns",
        parentId: "first",
        ts: TS_TODAY + 1000,
        cost: 100,
        input: 1,
        output: 1,
      }),
      // >5min idle, cacheRead ~0 → resume-after-break (TTL) miss.
      assistantLine({
        id: "ttl",
        parentId: "nested-between-turns",
        ts: TS_TODAY + SIX_MIN,
        cost: 10,
        input: 100000,
        cacheRead: 0,
      }),
      // Short gap, cacheRead ~0 → true prefix-change miss.
      assistantLine({
        id: "prefix",
        parentId: "ttl",
        ts: TS_TODAY + SIX_MIN + 10_000,
        cost: 5,
        input: 100000,
        cacheRead: 0,
      }),
      // Compaction between messages → excluded from prefix accounting.
      '{"type":"compaction","id":"c1","parentId":"prefix"}',
      assistantLine({
        id: "compacted",
        parentId: "c1",
        ts: TS_TODAY + SIX_MIN + 20_000,
        cost: 7,
        input: 100000,
        cacheRead: 0,
      }),
      // Short gap but a different model → model-switch miss, not prefix.
      assistantLine({
        id: "switched",
        parentId: "compacted",
        ts: TS_TODAY + SIX_MIN + 30_000,
        cost: 60,
        input: 100000,
        cacheRead: 0,
        model: "gpt-5.6-sol",
      }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  const ttl = findInsight(data, "today", /resuming conversations after a break/);
  assert.ok(ttl, "resume alarm fires");
  assert.equal(ttl.kind, "alarm");
  assert.equal(ttl.stat, "$10.00");
  assert.match(ttl.headline, /12% of assistant-message cost/);
  const prefix = findInsight(data, "today", /re-sending conversations mid-session/);
  assert.ok(prefix, "prefix alarm fires");
  assert.equal(prefix.stat, "$5.00", "compaction- and switch-adjacent misses are excluded from prefix cost");
  assert.match(prefix.headline, /6\.0% of assistant-message cost/);
  const sw = findInsight(data, "today", /switching models mid-conversation/);
  assert.ok(sw, "model-switch alarm fires");
  assert.equal(sw.stat, "$60.00");
  assert.match(sw.headline, /72% of assistant-message cost/);
});

test("context edits on a branch explain only the next miss, including after cache warming", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const original = join(sessionsDir, "a.jsonl");
  const common = assistantLine({ id: "common", ts: TS_TODAY, cost: 1, input: 1000, cacheRead: 100_000 });
  writeFileSync(
    original,
    `${[sessionLine("original", TS_TODAY), common, assistantLine({ id: "real-miss", parentId: "common", ts: TS_TODAY + 1000, cost: 5, input: 100_000, cacheRead: 0 })].join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, "b.jsonl"),
    `${[
      sessionLine("branch", TS_TODAY, "/tmp", original),
      common,
      contextEditLine("edit", TS_TODAY + 1000, "common"),
      usageEntryLine({
        id: "warm",
        parentId: "edit",
        ts: TS_TODAY + 1500,
        cost: 1,
        input: 0,
        output: 0,
        cacheRead: 50_000,
      }),
      assistantLine({
        id: "edited-miss",
        parentId: "warm",
        ts: TS_TODAY + 2000,
        cost: 7,
        input: 100_000,
        cacheRead: 0,
      }),
      assistantLine({
        id: "later-miss",
        parentId: "edited-miss",
        ts: TS_TODAY + 3000,
        cost: 3,
        input: 100_000,
        cacheRead: 0,
      }),
    ].join("\n")}\n`,
  );

  for (const filesToParse of [2, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.cost, 17, "one copied assistant plus a separately billed warm call");
    assert.equal(data.today.totals.messages, 4, "context edits and cache warming are not assistant turns");
    assert.equal(data.today.providers.get("anthropic").cost, 17);
    const prefix = findInsight(data, "today", /re-sending conversations mid-session/);
    assert.equal(prefix.stat, "$8.00", "the edited request is explained, but later and unedited misses still count");
    assert.match(prefix.headline, /50% of assistant-message cost/);
    assert.match(prefix.advice, /context edit/);
  }
});

test("editing a new user message leaves a genuine cached-prefix miss visible", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const lines = [
    sessionLine("new-user-edit", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY, cost: 1, input: 1000, cacheRead: 100_000 }),
    JSON.stringify({
      type: "message",
      id: "new-user",
      parentId: "first",
      message: { role: "user", content: [{ type: "text", text: "new prompt" }] },
    }),
    contextEditLine("edit-new-user", TS_TODAY + 1000, "new-user", "new-user"),
    assistantLine({ id: "second", parentId: "edit-new-user", ts: TS_TODAY + 2000, cost: 5, input: 100_000 }),
  ];
  const filePath = join(sessionsDir, "new-user.jsonl");
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => [m.sourceId, m.previousAssistantId, Boolean(m.afterContextEdit)]),
    [
      ["first", "", false],
      ["second", "first", false],
    ],
  );
  for (const filesToParse of [1, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.cost, 6);
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/)?.stat, "$5.00");
  }
});

test("a sibling of a context edit keeps its real prefix miss, even across a large tool result", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const file = join(sessionsDir, "branched.jsonl");
  const lines = [
    sessionLine("branched", TS_TODAY),
    assistantLine({ id: "common", ts: TS_TODAY, input: 1000, cacheRead: 100_000 }),
    contextEditLine("edit", TS_TODAY + 1000, "common"),
    // Append order is not ancestry: this request branched from before the edit.
    assistantLine({ id: "sibling", parentId: "common", ts: TS_TODAY + 2000, cost: 5, input: 100_000 }),
    JSON.stringify({
      type: "message",
      id: "big-tool",
      parentId: "edit",
      timestamp: new Date(TS_TODAY + 2500).toISOString(),
      message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(100_000) }] },
    }).replace(/^/, "  "), // Valid leading whitespace must not hide id/parentId in a skipped large entry.
    assistantLine({ id: "edited", parentId: "big-tool", ts: TS_TODAY + 3000, cost: 7, input: 100_000 }),
    assistantLine({ id: "later", parentId: "edited", ts: TS_TODAY + 4000, cost: 3, input: 100_000 }),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => Boolean(m.afterContextEdit)),
    [false, false, true, false],
  );

  for (const filesToParse of [1, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.messages, 4);
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$8.00");
  }
});

test("cache warming refreshes only its branch, and assistant context follows parent ancestry", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const lines = [
    sessionLine("branched", TS_TODAY),
    assistantLine({ id: "common", ts: TS_TODAY, input: 1000, cacheRead: 100_000 }),
    usageEntryLine({ id: "warm", parentId: "common", ts: TS_TODAY + 4.5 * 60_000, cost: 0.5 }),
    assistantLine({
      id: "recent-sibling",
      parentId: "common",
      ts: TS_TODAY + 5 * 60_000,
      cost: 2,
      cacheRead: 100_000,
    }),
    assistantLine({ id: "unwarmed", parentId: "common", ts: TS_TODAY + 6 * 60_000, cost: 5, input: 100_000 }),
    assistantLine({ id: "warmed", parentId: "warm", ts: TS_TODAY + 6 * 60_000 + 1000, cost: 7, input: 100_000 }),
  ];
  writeFileSync(join(sessionsDir, "branched.jsonl"), `${lines.join("\n")}\n`);
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.equal(parsed.messages.at(-2)?.previousAssistantId, "common");
  assert.equal(parsed.messages.at(-2)?.branchWarmAt, undefined);
  assert.equal(parsed.messages.at(-1)?.previousAssistantId, "common");
  assert.equal(parsed.messages.at(-1)?.branchWarmAt, TS_TODAY + 4.5 * 60_000);

  for (const filesToParse of [1, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.messages, 4);
    assert.equal(findInsight(data, "today", /resuming conversations after a break/).stat, "$5.00");
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$7.00");
  }
});

test("editing a target discarded by compaction does not explain a later cache miss", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const lines = [
    sessionLine("compacted", TS_TODAY),
    assistantLine({ id: "common", ts: TS_TODAY, input: 1000, cacheRead: 100_000 }),
    JSON.stringify({
      type: "message",
      id: "old",
      parentId: "common",
      timestamp: new Date(TS_TODAY + 1000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "old" }] },
    }),
    compactionLine({ id: "drop", parentId: "old", firstKeptEntryId: "drop", ts: TS_TODAY + 2000 }),
    assistantLine({ id: "after-drop", parentId: "drop", ts: TS_TODAY + 3000, cacheRead: 100_000 }),
    contextEditLine("edit-drop", TS_TODAY + 4000, "old", "after-drop"),
    assistantLine({ id: "miss-drop", parentId: "edit-drop", ts: TS_TODAY + 5000, cost: 5, input: 100_000 }),
    compactionLine({ id: "keep", parentId: "old", firstKeptEntryId: "old", ts: TS_TODAY + 2000 }),
    assistantLine({ id: "after-keep", parentId: "keep", ts: TS_TODAY + 3000, cacheRead: 100_000 }),
    contextEditLine("edit-keep", TS_TODAY + 4000, "old", "after-keep"),
    assistantLine({ id: "miss-keep", parentId: "edit-keep", ts: TS_TODAY + 5000, cost: 7, input: 100_000 }),
  ];
  writeFileSync(join(sessionsDir, "compacted.jsonl"), `${lines.join("\n")}\n`);
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.filter((m) => m.source === "assistant").map((m) => Boolean(m.afterContextEdit)),
    [false, false, false, false, true],
  );
  for (const filesToParse of [1, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$5.00");
  }
});

test("editing an aborted assistant does not change Pi's provider-visible context", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const aborted = JSON.parse(
    assistantLine({ id: "aborted", parentId: "first", ts: TS_TODAY + 100, cost: 2, cacheRead: 100_000 }),
  );
  aborted.message.stopReason = "aborted";
  const lines = [
    sessionLine("aborted-edit", TS_TODAY),
    userLine(TS_TODAY),
    assistantLine({ id: "first", parentId: "u1", ts: TS_TODAY, cost: 1, cacheRead: 100_000 }),
    JSON.stringify(aborted),
    contextEditLine("edit-aborted", TS_TODAY + 200, "aborted", "aborted"),
    assistantLine({ id: "next", parentId: "edit-aborted", ts: TS_TODAY + 300, cost: 5, input: 100_000 }),
  ];
  const jsonl = `${lines.join("\n")}\n`;
  const file = join(sessionsDir, "aborted-edit.jsonl");
  writeFileSync(file, jsonl);
  const pi = SessionManager.open(file);
  const providerModel = { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5", input: ["text"] };
  pi.branch("aborted");
  const before = transformMessages(pi.buildSessionProjection().messages, providerModel).map((m) => m.role);
  pi.branch("edit-aborted");
  const after = transformMessages(pi.buildSessionProjection().messages, providerModel).map((m) => m.role);
  assert.deepEqual(
    [before, after],
    [
      ["user", "assistant"],
      ["user", "assistant"],
    ],
  );

  const parsed = await parseSessionBuffer(Buffer.from(jsonl));
  assert.deepEqual(
    parsed.messages.map((m) => [m.sourceId, m.previousAssistantId, Boolean(m.afterContextEdit)]),
    [
      ["first", "", false],
      ["aborted", "first", false],
      ["next", "aborted", false],
    ],
  );
  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(findInsight(data, "today", /re-sending conversations mid-session/)?.stat, "$5.00");
});

test("a later compaction resurrects a hidden edit as Pi projects it", async (t) => {
  const { sessionsDir } = fixture(t);
  const replacement = { content: [{ type: "text", text: "new" }] };
  const lines = [
    sessionLine("resurrect-hidden-edit", TS_TODAY),
    userLine(TS_TODAY, "old"),
    assistantLine({ id: "first", parentId: "u1", ts: TS_TODAY, cost: 1 }),
    compactionLine({ id: "drop", parentId: "first", firstKeptEntryId: "drop", ts: TS_TODAY + 100 }),
    assistantLine({ id: "second", parentId: "drop", ts: TS_TODAY + 200, cost: 2 }),
    contextEditLine("hidden-edit", TS_TODAY + 300, "u1", "second", replacement),
    compactionLine({ id: "resurrect", parentId: "hidden-edit", firstKeptEntryId: "u1", ts: TS_TODAY + 400 }),
    assistantLine({ id: "third", parentId: "resurrect", ts: TS_TODAY + 500, cost: 3 }),
    contextEditLine("same-edit", TS_TODAY + 600, "u1", "third", replacement),
    assistantLine({ id: "fourth", parentId: "same-edit", ts: TS_TODAY + 700, cost: 5 }),
  ];
  const jsonl = `${lines.join("\n")}\n`;
  const file = join(sessionsDir, "resurrect-hidden-edit.jsonl");
  writeFileSync(file, jsonl);
  const pi = SessionManager.open(file);
  const projectedUser = (leaf: string) => {
    pi.branch(leaf);
    return pi.buildSessionProjection().entries.find(({ sourceEntry }) => sourceEntry.id === "u1")?.messages;
  };
  pi.branch("second");
  assert.deepEqual(
    pi.buildSessionProjection().entries.map(({ sourceEntry }) => sourceEntry.id),
    ["drop", "second"],
  );
  assert.deepEqual(
    projectedUser("third")?.map((m) => m.content),
    [replacement.content],
  );
  assert.deepEqual(
    projectedUser("fourth")?.map((m) => m.content),
    [replacement.content],
  );

  const parsed = await parseSessionBuffer(Buffer.from(jsonl));
  assert.deepEqual(
    parsed.messages
      .filter((m) => m.source === "assistant")
      .map((m) => [m.sourceId, Boolean(m.afterContextEdit), m.afterCompaction]),
    [
      ["first", false, false],
      ["second", false, true],
      ["third", false, true],
      ["fourth", false, false],
    ],
  );
});

test("an edit resurrected by a later compaction does not rewrite the prior assistant context", async () => {
  const oldUser = JSON.stringify({
    type: "message",
    id: "old",
    parentId: "first",
    message: { role: "user", content: [{ type: "text", text: "old context" }] },
  });
  const lines = [
    sessionLine("resurrected", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY }),
    oldUser,
    compactionLine({ id: "drop", parentId: "old", firstKeptEntryId: "drop", ts: TS_TODAY + 100 }),
    assistantLine({ id: "second", parentId: "drop", ts: TS_TODAY + 200 }),
    compactionLine({ id: "resurrect", parentId: "second", firstKeptEntryId: "old", ts: TS_TODAY + 300 }),
    contextEditLine("newly-visible", TS_TODAY + 400, "old", "resurrect"),
    assistantLine({ id: "third", parentId: "newly-visible", ts: TS_TODAY + 500 }),
    contextEditLine("restore", TS_TODAY + 600, "old", "third", {
      content: [{ type: "text", text: "old context" }],
    }),
    assistantLine({ id: "fourth", parentId: "restore", ts: TS_TODAY + 700 }),
  ];
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages
      .filter((m) => m.source === "assistant")
      .map((m) => [m.sourceId, Boolean(m.afterContextEdit), m.afterCompaction]),
    [
      ["first", false, false],
      ["second", false, true],
      ["third", false, true],
      ["fourth", true, false],
    ],
  );
});

test("matching cache warming at 4m30 refreshes TTL before the assistant at 6m", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const warmAt = TS_TODAY + 4.5 * 60_000;
  const assistantAt = TS_TODAY + 6 * 60_000;
  for (const [id, kind, provider, model, cost] of [
    ["matching", "cache_warm", "anthropic", "claude-fable-5", 5],
    ["other-model", "cache_warm", "anthropic", "other-model", 7],
    ["other-provider", "cache_warm", "openai", "claude-fable-5", 11],
    ["other-kind", "future_kind", "anthropic", "claude-fable-5", 9],
  ] as const) {
    writeFileSync(
      join(sessionsDir, `${id}.jsonl`),
      `${[
        sessionLine(id, TS_TODAY),
        assistantLine({ id: `${id}-first`, ts: TS_TODAY, input: 1000, cacheRead: 100_000 }),
        usageEntryLine({
          id: `${id}-warm`,
          parentId: `${id}-first`,
          ts: warmAt,
          kind,
          provider,
          model,
          cost: 0.5,
          cacheRead: 50_000,
        }),
        assistantLine({ id: `${id}-next`, parentId: `${id}-warm`, ts: assistantAt, cost, input: 100_000 }),
      ].join("\n")}\n`,
    );
  }

  for (const filesToParse of [4, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.messages, 8);
    assert.equal(findInsight(data, "today", /resuming conversations after a break/).stat, "$27.00");
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$5.00");
  }
});

test("Pi response-model cache warms match an alias without hiding a concrete model switch", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const alias = "claude-fable-5";
  const concrete = "claude-fable-5-20260930";
  const switched = "claude-fable-5-20261001";
  const lines = [
    sessionLine("alias", TS_TODAY),
    assistantLine({
      id: "first",
      ts: TS_TODAY,
      model: alias,
      responseModel: concrete,
      input: 1000,
      cacheRead: 100_000,
    }),
    // Pi appends the concrete responseModel as usage.model, not the request alias.
    usageEntryLine({ id: "warm", parentId: "first", ts: TS_TODAY + 4.5 * 60_000, model: concrete, cost: 0.25 }),
    assistantLine({
      id: "same",
      parentId: "warm",
      ts: TS_TODAY + 6 * 60_000,
      model: alias,
      responseModel: concrete,
      cost: 3,
      input: 100_000,
    }),
    assistantLine({
      id: "changed",
      parentId: "warm",
      ts: TS_TODAY + 6 * 60_000,
      model: alias,
      responseModel: switched,
      cost: 5,
      input: 100_000,
    }),
    assistantLine({
      id: "quick-switch",
      parentId: "first",
      ts: TS_TODAY + 60_000,
      model: alias,
      responseModel: switched,
      cost: 7,
      input: 100_000,
    }),
  ];
  const filePath = join(sessionsDir, "alias.jsonl");
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.filter((m) => m.source === "assistant").map((m) => [m.responseModel, m.branchWarmAt]),
    [
      [concrete, undefined],
      [concrete, TS_TODAY + 4.5 * 60_000],
      [switched, undefined],
      [switched, undefined],
    ],
  );
  for (const filesToParse of [1, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.cost, 16.25);
    assert.equal(data.today.totals.messages, 4);
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$3.00");
    assert.equal(findInsight(data, "today", /resuming conversations after a break/).stat, "$5.00");
    assert.equal(findInsight(data, "today", /switching models mid-conversation/).stat, "$7.00");
    assert.equal(data.today.providers.get("anthropic").models.get(alias).cost, 16);
    assert.equal(data.today.providers.get("anthropic").models.get(concrete).cost, 0.25);
  }
});

test("zero-usage warm refreshes branch TTL without inventing cost, tokens, or a turn", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const lines = [
    sessionLine("zero", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY, input: 1000, cacheRead: 100_000 }),
    usageEntryLine({
      id: "zero-warm",
      parentId: "first",
      ts: TS_TODAY + 4.5 * 60_000,
      cost: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
    }),
    assistantLine({ id: "warmed", parentId: "zero-warm", ts: TS_TODAY + 6 * 60_000, cost: 5, input: 100_000 }),
    assistantLine({ id: "sibling", parentId: "first", ts: TS_TODAY + 6 * 60_000, cost: 7, input: 100_000 }),
  ];
  writeFileSync(join(sessionsDir, "zero.jsonl"), `${lines.join("\n")}\n`);
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.equal(parsed.messages.length, 3);
  assert.equal(parsed.messages[1].branchWarmAt, TS_TODAY + 4.5 * 60_000);
  assert.equal(parsed.messages[2].branchWarmAt, undefined);
  for (const filesToParse of [1, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.cost, 13);
    assert.equal(data.today.totals.messages, 3);
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$5.00");
    assert.equal(findInsight(data, "today", /resuming conversations after a break/).stat, "$7.00");
  }
});

test("no-op replacements, repeated edits, omissions, and reverts preserve real prefix misses", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const original = [{ type: "text", text: "hi" }];
  const changed = [{ type: "text", text: "changed" }];
  const lines = [
    sessionLine("edits", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY, input: 1000, cacheRead: 100_000 }),
    contextEditLine("same-original", TS_TODAY + 100, "first", "first", { content: original }),
    assistantLine({ id: "miss-original", parentId: "same-original", ts: TS_TODAY + 200, cost: 2, input: 100_000 }),
    contextEditLine("change", TS_TODAY + 300, "first", "miss-original", { content: changed }),
    assistantLine({ id: "changed-hit", parentId: "change", ts: TS_TODAY + 400, cacheRead: 100_000 }),
    contextEditLine("repeat", TS_TODAY + 500, "first", "changed-hit", { content: changed }),
    assistantLine({ id: "miss-repeat", parentId: "repeat", ts: TS_TODAY + 600, cost: 3, input: 100_000 }),
    contextEditLine("omit", TS_TODAY + 700, "first", "miss-repeat"),
    assistantLine({ id: "omit-hit", parentId: "omit", ts: TS_TODAY + 800, cacheRead: 100_000 }),
    contextEditLine("repeat-omit", TS_TODAY + 900, "first", "omit-hit"),
    assistantLine({ id: "miss-omit", parentId: "repeat-omit", ts: TS_TODAY + 1000, cost: 5, input: 100_000 }),
    contextEditLine("restore", TS_TODAY + 1100, "first", "miss-omit", { content: changed }),
    contextEditLine("revert", TS_TODAY + 1200, "first", "restore"),
    assistantLine({ id: "miss-revert", parentId: "revert", ts: TS_TODAY + 1300, cost: 7, input: 100_000 }),
  ];
  writeFileSync(join(sessionsDir, "edits.jsonl"), `${lines.join("\n")}\n`);
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => Boolean(m.afterContextEdit)),
    [false, false, true, false, true, false, false],
  );
  for (const filesToParse of [1, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(data.today.totals.messages, 7);
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$17.00");
  }
});

test("a kept edit remains effective through compaction and an identical later edit is a no-op", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const replacement = { content: "new context" };
  const lines = [
    sessionLine("compact-edit", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY, input: 1000, cacheRead: 100_000 }),
    contextEditLine("changed", TS_TODAY + 100, "first", "first", replacement),
    compactionLine({
      id: "compact",
      parentId: "changed",
      firstKeptEntryId: "first",
      ts: TS_TODAY + 200,
      cost: 0,
      input: 0,
      output: 0,
    }),
    assistantLine({ id: "after-compact", parentId: "compact", ts: TS_TODAY + 300, cacheRead: 100_000 }),
    contextEditLine("same", TS_TODAY + 400, "first", "after-compact", replacement),
    assistantLine({ id: "miss", parentId: "same", ts: TS_TODAY + 500, cost: 5, input: 100_000 }),
  ];
  writeFileSync(join(sessionsDir, "compact-edit.jsonl"), `${lines.join("\n")}\n`);
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => Boolean(m.afterContextEdit)),
    [false, false, false],
  );
  for (const filesToParse of [1, 0]) {
    const progress = [];
    const data = await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => progress.push(p) });
    assert.equal(progress[0].filesToParse, filesToParse);
    assert.equal(findInsight(data, "today", /re-sending conversations mid-session/).stat, "$5.00");
  }
});

test("sibling edits of the same target keep independent effective content and baselines", async () => {
  const original = { content: [{ type: "text", text: "hi" }] };
  const changed = { content: "changed" };
  const lines = [
    sessionLine("sibling-edits", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY }),
    contextEditLine("left", TS_TODAY + 100, "first", "first", changed),
    contextEditLine("left-again", TS_TODAY + 200, "first", "left", changed),
    assistantLine({ id: "left-answer", parentId: "left-again", ts: TS_TODAY + 300 }),
    contextEditLine("right-noop", TS_TODAY + 400, "first", "first", original),
    assistantLine({ id: "right-answer", parentId: "right-noop", ts: TS_TODAY + 500 }),
    contextEditLine("right-omit", TS_TODAY + 600, "first", "first"),
    assistantLine({ id: "right-omitted", parentId: "right-omit", ts: TS_TODAY + 700 }),
    contextEditLine("left-revert", TS_TODAY + 800, "first", "left-again", original),
    assistantLine({ id: "left-restored", parentId: "left-revert", ts: TS_TODAY + 900 }),
  ];
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => [m.sourceId, Boolean(m.afterContextEdit)]),
    [
      ["first", false],
      ["left-answer", true],
      ["right-answer", false],
      ["right-omitted", true],
      ["left-restored", false],
    ],
  );
});

test("many distinct targets can all revert without changing a sibling branch", async () => {
  const original = [{ type: "text", text: "before" }];
  const lines = [sessionLine("distinct-reverts", TS_TODAY), assistantLine({ id: "first", ts: TS_TODAY })];
  let parentId = "first";
  const targets: string[] = [];
  for (let index = 0; index < 127; index++) {
    const targetId = `target-${String(index).padStart(3, "0")}`;
    targets.push(targetId);
    lines.push(
      JSON.stringify({ type: "message", id: targetId, parentId, message: { role: "user", content: original } }),
    );
    const editId = `omit-${index}`;
    lines.push(contextEditLine(editId, TS_TODAY + index, targetId, targetId));
    parentId = editId;
  }
  lines.push(assistantLine({ id: "omitted", parentId, ts: TS_TODAY + 1000 }));
  // Delete keys from both ends and the middle of the shared AVL tree.
  for (let index = 0; index < targets.length; index++) {
    const targetId = targets[index % 2 === 0 ? index / 2 : targets.length - 1 - (index - 1) / 2];
    const editId = `restore-${index}`;
    lines.push(contextEditLine(editId, TS_TODAY + 1100 + index, targetId, parentId, { content: original }));
    parentId = editId;
  }
  lines.push(assistantLine({ id: "restored", parentId, ts: TS_TODAY + 2000 }));
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => [m.sourceId, Boolean(m.afterContextEdit)]),
    [
      ["first", false],
      ["omitted", false], // Those users arrived after the prior assistant, outside its cached prefix.
      ["restored", false],
    ],
  );
});

test("compaction retains a kept edit, clears pending changes, and resets the next baseline", async () => {
  const replacement = { content: "new context" };
  const original = { content: [{ type: "text", text: "hi" }] };
  const lines = [
    sessionLine("compaction-baseline", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY }),
    contextEditLine("changed", TS_TODAY + 100, "first", "first", replacement),
    compactionLine({
      id: "compact",
      parentId: "changed",
      firstKeptEntryId: "first",
      ts: TS_TODAY + 200,
      cost: 0,
      input: 0,
      output: 0,
    }),
    contextEditLine("same", TS_TODAY + 300, "first", "compact", replacement),
    assistantLine({ id: "after-compact", parentId: "same", ts: TS_TODAY + 400 }),
    contextEditLine("restore", TS_TODAY + 500, "first", "after-compact", original),
    assistantLine({ id: "restored", parentId: "restore", ts: TS_TODAY + 600 }),
    contextEditLine("change-again", TS_TODAY + 700, "first", "restored", replacement),
    assistantLine({ id: "changed-again", parentId: "change-again", ts: TS_TODAY + 800 }),
    contextEditLine("repeat", TS_TODAY + 900, "first", "changed-again", replacement),
    assistantLine({ id: "no-op", parentId: "repeat", ts: TS_TODAY + 1000 }),
  ];
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => [m.sourceId, Boolean(m.afterContextEdit), m.afterCompaction]),
    [
      ["first", false, false],
      ["after-compact", false, true],
      ["restored", true, false],
      ["changed-again", true, false],
      ["no-op", false, false],
    ],
  );
});

test("late and duplicate lineage ids use the bounded ancestry walk", async () => {
  const user = (id: string, parentId: string | null) =>
    JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: "user" } });
  const lines = [
    sessionLine("malformed-lineage", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY }),
    user("orphan", "future"), // Parent appears only after the child was indexed.
    user("future", "first"),
    contextEditLine("late-edit", TS_TODAY + 100, "first", "orphan"),
    assistantLine({ id: "late", parentId: "late-edit", ts: TS_TODAY + 200 }),
    user("mid", "first"),
    user("leaf", "mid"),
    user("other-root", null),
    user("mid", "other-root"), // Invalidates the canonical path cached for leaf.
    contextEditLine("not-ancestor", TS_TODAY + 300, "first", "leaf"),
    assistantLine({ id: "duplicate", parentId: "not-ancestor", ts: TS_TODAY + 400 }),
  ];
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => [m.sourceId, Boolean(m.afterContextEdit)]),
    [
      ["first", false],
      ["late", false], // The unresolved parent did not carry a known previous assistant request.
      ["duplicate", false],
    ],
  );
});

test("cyclic imported lineage stops at a repeated id while preserving independent accounting", async () => {
  const lines = [
    sessionLine("cyclic", TS_TODAY),
    assistantLine({ id: "first", ts: TS_TODAY, cost: 2 }),
    JSON.stringify({ type: "message", id: "cycle-a", parentId: "cycle-b", message: { role: "user", content: [] } }),
    JSON.stringify({ type: "message", id: "cycle-b", parentId: "cycle-a", message: { role: "user", content: [] } }),
    contextEditLine("edit", TS_TODAY + 100, "first", "cycle-b"),
    assistantLine({ id: "second", parentId: "edit", ts: TS_TODAY + 200, cost: 3 }),
  ];
  const parsed = await parseSessionBuffer(Buffer.from(lines.join("\n")));
  assert.deepEqual(
    parsed.messages.map((m) => [m.sourceId, m.cost, m.previousAssistantId, Boolean(m.afterContextEdit)]),
    [
      ["first", 2, "", false],
      ["second", 3, "", false],
    ],
  );
});

test("pi test providers are excluded from all stats", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[
      sessionLine("s1", TS_TODAY),
      assistantLine({ ts: TS_TODAY, cost: 2 }),
      assistantLine({ ts: TS_TODAY + 1000, cost: 99, provider: "faux-provider", model: "faux" }),
      assistantLine({ ts: TS_TODAY + 2000, cost: 99, provider: "fake-provider", model: "fake" }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  assert.equal(data.today.totals.cost, 2, "test-provider cost is excluded");
  assert.equal(data.today.totals.messages, 1, "test-provider messages are excluded");
  assert.ok(!data.today.providers.has("faux-provider"));
  assert.ok(!data.today.providers.has("fake-provider"));
});

test("insights fire upfront and concentration alarms when material", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  for (let i = 0; i < 7; i++) {
    const cost = i < 5 ? 10 : 1; // top-5 sessions dominate
    writeFileSync(
      join(sessionsDir, `s${i}.jsonl`),
      `${[sessionLine(`s${i}`, TS_TODAY + i), assistantLine({ ts: TS_TODAY + i, cost })].join("\n")}\n`,
    );
  }

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  const upfront = findInsight(data, "today", /opening message of new sessions/);
  assert.ok(upfront, "upfront alarm fires (every message is a session start here)");
  assert.equal(upfront.kind, "alarm");
  assert.equal(upfront.stat, "$52.00");
  assert.match(upfront.headline, /100% of this period/);
  const conc = findInsight(data, "today", /came from just 5 of your 7 sessions/);
  assert.ok(conc, "concentration alarm fires");
  assert.equal(conc.stat, "$50.00"); // top 5 of $52 total
  assert.match(conc.headline, /96% of this period/);
});

test("insights include context tax, project mix, and reasoning share", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const alpha = join(homedir(), "projects/alpha");
  const beta = join(homedir(), "projects/beta/.worktrees/task");
  writeFileSync(
    join(sessionsDir, "alpha.jsonl"),
    `${[
      sessionLine("sa", TS_TODAY, alpha),
      assistantLine({ ts: TS_TODAY, cost: 6, input: 200000, output: 50 }),
      assistantLine({ ts: TS_TODAY + 1000, cost: 6, input: 200000, output: 50 }),
      // A large auxiliary call contributes to project/total cost but not the
      // assistant-message denominator of the context insight.
      toolResultLine({ id: "alpha-tool", ts: TS_TODAY + 1500, cost: 16, input: 10, output: 1 }),
    ].join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, "beta.jsonl"),
    `${[
      sessionLine("sb", TS_TODAY, beta),
      assistantLine({ ts: TS_TODAY + 2000, cost: 2, input: 1000, output: 100, reasoning: 50 }),
      assistantLine({ ts: TS_TODAY + 3000, cost: 2, input: 1000, output: 100, reasoning: 50 }),
    ].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  const ctx = findInsight(data, "today", /≥150k tokens loaded/);
  assert.ok(ctx, "context tax shows");
  assert.equal(ctx.kind, "structure");
  assert.equal(ctx.stat, "75%"); // 12 of 16 assistant-message dollars
  assert.match(ctx.headline, /assistant-message cost/);
  assert.match(ctx.headline, /\$6\.00\/msg vs \$2\.00 under 100k/);
  const proj = findInsight(data, "today", /~\/projects\/alpha/);
  assert.ok(proj, "project mix shows");
  assert.equal(proj.stat, "88%");
  assert.match(proj.headline, /~\/projects\/beta 13%/, "auxiliary cost is included and the worktree collapses");
  const reas = findInsight(data, "today", /hidden reasoning/);
  assert.ok(reas, "reasoning share shows");
  assert.equal(reas.stat, "33%"); // 100 of 300 output tokens
});

test("insights report the burn trend against the prior 4-week pace", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  const TS_20D_AGO = new Date(2026, 5, 25, 10, 0, 0).getTime();
  writeFileSync(
    join(sessionsDir, "now.jsonl"),
    `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY, cost: 70 })].join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, "old.jsonl"),
    `${[sessionLine("s2", TS_20D_AGO), assistantLine({ ts: TS_20D_AGO, cost: 40 })].join("\n")}\n`,
  );

  const data = await collectUsageData({ sessionsDir, cachePath, now: NOW });
  const trend = findInsight(data, "allTime", /last 7 days/);
  assert.ok(trend, "trend shows");
  assert.equal(trend.kind, "structure");
  assert.equal(trend.stat, "7.0×"); // $70 vs $40/4 = $10 weekly pace
  assert.match(trend.headline, /\$70\.00.*\$10\.00\/wk/);
  assert.match(trend.advice, /Spending is up/);
  // The same global trend line is present on every period tab.
  assert.ok(findInsight(data, "today", /last 7 days/));
});

// =============================================================================
// Progress reporting
// =============================================================================

test("collectUsageData reports first-run, update, and rebuild progress modes", async (t) => {
  const { sessionsDir, cachePath } = fixture(t);
  writeFileSync(
    join(sessionsDir, "a.jsonl"),
    `${[sessionLine("s1", TS_TODAY), assistantLine({ ts: TS_TODAY, cost: 1 })].join("\n")}\n`,
  );

  // First run: no cache file exists yet.
  let events = [];
  await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => events.push(p) });
  assert.ok(events.length >= 1);
  assert.equal(events[0].mode, "first-run");
  assert.equal(events[0].filesToParse, 1);
  assert.equal(events[0].sinceMs, null);
  assert.equal(events.at(-1).filesParsed, 1);

  // Warm no-op: nothing to parse.
  events = [];
  await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => events.push(p) });
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, "update");
  assert.equal(events[0].filesToParse, 0);

  // Incremental update: one new file; sinceMs is the newest already-cached mtime.
  writeFileSync(
    join(sessionsDir, "b.jsonl"),
    `${[sessionLine("s2", TS_TODAY), assistantLine({ ts: TS_TODAY + 1000, cost: 2 })].join("\n")}\n`,
  );
  const cachedMtimes = Object.values(JSON.parse(readFileSync(cachePath, "utf8")).files).map((f) => f.mtimeMs);
  events = [];
  await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => events.push(p) });
  assert.equal(events[0].mode, "update");
  assert.equal(events[0].filesToParse, 1);
  assert.equal(events[0].sinceMs, Math.max(...cachedMtimes));
  assert.equal(events.at(-1).filesParsed, 1);

  // Rebuild: cache file exists but is unusable (e.g. an older format version).
  writeFileSync(cachePath, JSON.stringify({ version: 1, names: [], files: {} }));
  events = [];
  await collectUsageData({ sessionsDir, cachePath, now: NOW, onProgress: (p) => events.push(p) });
  assert.equal(events[0].mode, "rebuild");
  assert.equal(events[0].filesToParse, 2);
  assert.equal(events[0].sinceMs, null);
});

test("projectLabelFromCwd collapses cwds to stable project labels", () => {
  assert.equal(projectLabelFromCwd(""), "(unknown)");
  assert.equal(projectLabelFromCwd(homedir()), "~");
  assert.equal(projectLabelFromCwd(join(homedir(), "projects/foo/sub/dir")), "~/projects/foo");
  assert.equal(projectLabelFromCwd(join(homedir(), "projects/foo/.worktrees/bar/deep")), "~/projects/foo");
  assert.equal(projectLabelFromCwd("/tmp/xyz/abc"), "/tmp/xyz");
  // Home prefixes from other machines/usernames collapse to "~" too.
  assert.equal(projectLabelFromCwd("/Users/olduser/projects/customers/xpo"), "~/projects/customers");
  assert.equal(projectLabelFromCwd("/home/olduser/work"), "~/work");
  assert.equal(projectLabelFromCwd("/Users/olduser"), "~");
});

test("loadUsageCache returns empty for a missing cache file", async (t) => {
  const { root } = fixture(t);
  assert.equal((await loadUsageCache(join(root, "nope.json"))).size, 0);
});

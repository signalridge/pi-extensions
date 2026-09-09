import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "../src/checkpoint.js";

import { createCodexCompactExtension } from "../src/codex-compact.js";
import { DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

const user: AgentMessage = { role: "user", content: "retained request", timestamp: 1 };
const assistant = (stopReason: "error" | "length" | "stop", timestamp = 2): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "response" }],
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: "gpt-5.6",
  stopReason,
  timestamp,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const detailsFor = (keptMessages: AgentMessage[], willRetry = true) =>
  createCheckpointDetails({
    modelId: "gpt-5.6",
    keptMessages,
    willRetry,
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
  });

for (const reason of ["error", "length"] as const) {
  test(`${reason}: projection follows native persisted rebuild -> runtime-only tail trim -> continuation`, async () => {
    const session = SessionManager.inMemory();
    const keptId = session.appendMessage(user);
    const tail = assistant(reason);
    session.appendMessage(tail);
    const details = detailsFor([user, tail]);
    assert.deepEqual(details.retryTrimmedTail, tail);
    session.appendCompaction(fallbackSummary(details.checkpointId), keptId, 100, details, true);
    // _runAutoCompaction rebuilds agent state, emits session_compact, then removes
    // a trailing error/length assistant before agent.continue(). The branch is unchanged.
    const persisted = session.buildSessionContext().messages;
    assert.deepEqual(persisted.at(-1), tail);
    let runtime = persisted;
    const last = runtime.at(-1);
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "length"))
      runtime = runtime.slice(0, -1);
    assert.equal(projectCheckpointContext(runtime, details, "runtime-omitted")?.length, 1);
    assert.equal(projectCheckpointContext(persisted, details, "full")?.length, 1);
    const identical = structuredClone(tail);
    assert.notEqual(identical, tail);
    assert.equal(projectCheckpointContext([...runtime, identical], details), undefined);
    assert.deepEqual(projectCheckpointContext([...runtime, identical], details, "runtime-omitted")?.slice(1), [
      identical,
    ]);
    const newAssistant = assistant("stop", 3);
    assert.deepEqual(projectCheckpointContext([...runtime, newAssistant], details, "runtime-omitted")?.slice(1), [
      newAssistant,
    ]);
    session.appendMessage(newAssistant);
    assert.deepEqual(projectCheckpointContext(session.buildSessionContext().messages, details, "full")?.slice(1), [
      newAssistant,
    ]);

    // A later checkpoint may retain an older checkpoint's persisted error and summary.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondTail = assistant(reason, 4);
    session.appendMessage(secondTail);
    const second = detailsFor([user, tail, newAssistant, secondTail]);
    session.appendCompaction(fallbackSummary(second.checkpointId), keptId, 100, second, true);
    const secondPersisted = session.buildSessionContext().messages;
    assert.equal(projectCheckpointContext(secondPersisted, second, "full")?.length, 1);
    assert.equal(projectCheckpointContext(secondPersisted.slice(0, -1), second, "runtime-omitted")?.length, 1);
    // The retry proof never authorizes removing an older, unrelated error.
    assert.equal(
      projectCheckpointContext(
        secondPersisted.filter((message) => fingerprintMessage(message) !== fingerprintMessage(tail)),
        second,
      ),
      undefined,
    );
  });
}

for (const reason of ["error", "length"] as const) {
  test(`${reason}: extension lifecycle preserves occurrence provenance through reload, resets on rebuild`, async () => {
    const session = SessionManager.inMemory();
    const keptId = session.appendMessage(user);
    const tail = assistant(reason);
    session.appendMessage(tail);
    const details = detailsFor([user, tail]);
    session.appendCompaction(fallbackSummary(details.checkpointId), keptId, 100, details, true);
    const compactionEntry = session.getBranch().at(-1);
    const persisted = session.buildSessionContext().messages;
    const runtime = [...persisted.slice(0, -1), structuredClone(tail)];
    const { ctx } = createMockContext({
      sessionManager: session,
      model: { id: "gpt-5.6", provider: "openai-codex", api: "openai-codex-responses" },
    });
    const load = () => {
      const mock = createMockPi();
      const state = {
        kind: "missing" as const,
        path: "/tmp/unused-codex-settings.json",
        settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, enabled: true },
      };
      createCodexCompactExtension({
        settingsRuntime: {
          get: () => state,
          reload: async () => state,
          update: async () => state,
          flush: async () => {},
        },
      })(mock.pi);
      return async (type: string, fields: Record<string, unknown> = {}) => {
        const handler = mock.events.get(type)?.[0];
        assert.ok(handler);
        return (await handler({ type, ...fields }, ctx)) as { messages: AgentMessage[] } | undefined;
      };
    };
    let emit = load();
    await emit("session_start", { reason: "startup" });
    assert.equal((await emit("context", { messages: persisted }))?.messages.length, 1);
    await emit("session_compact", { willRetry: true, compactionEntry });
    assert.deepEqual((await emit("context", { messages: runtime }))?.messages.slice(1), [tail]);
    await emit("session_shutdown", { reason: "reload" });
    assert.equal(await emit("context", { messages: runtime }), undefined);
    emit = load();
    await emit("session_start", { reason: "reload" });
    assert.deepEqual((await emit("context", { messages: runtime }))?.messages.slice(1), [tail]);
    session.appendMessage(structuredClone(tail));
    await emit("session_tree");
    assert.deepEqual((await emit("context", { messages: session.buildSessionContext().messages }))?.messages.slice(1), [
      tail,
    ]);
    assert.equal((await emit("context", { messages: persisted }))?.messages.length, 1);
    for (const fresh of ["startup", "new", "resume", "fork"] as const) {
      await emit("session_compact", { willRetry: true, compactionEntry });
      await emit("session_shutdown", { reason: fresh === "startup" ? "quit" : fresh });
      emit = load();
      await emit("session_start", { reason: fresh });
      assert.equal((await emit("context", { messages: persisted }))?.messages.length, 1);
    }
    // A non-retry/native rebuild cannot inherit omission from an earlier event.
    await emit("session_compact", { willRetry: true, compactionEntry });
    await emit("session_compact", { willRetry: false, compactionEntry });
    assert.equal((await emit("context", { messages: persisted }))?.messages.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = detailsFor([user, tail, structuredClone(tail)]);
    session.appendCompaction(fallbackSummary(second.checkpointId), keptId, 100, second, true);
    const secondPersisted = session.buildSessionContext().messages;
    // Old checkpoint provenance cannot authorize projection for a new ID.
    assert.equal(await emit("context", { messages: secondPersisted }), undefined);
    await emit("session_compact", { willRetry: true, compactionEntry: session.getBranch().at(-1) });
    const secondRuntime = [...secondPersisted.slice(0, -1), structuredClone(tail)];
    assert.deepEqual((await emit("context", { messages: secondRuntime }))?.messages.slice(1), [tail]);
    session.appendCompaction("native summary", keptId, 100);
    await emit("session_compact", { willRetry: false, compactionEntry: session.getBranch().at(-1) });
    assert.equal(await emit("context", { messages: session.buildSessionContext().messages }), undefined);
  });
}

test("retry proof is optional, type-bound, fingerprint-bound and limited to the retained tail", () => {
  const tail = assistant("error");
  const details = detailsFor([user, tail]);
  const anchor: AgentMessage = {
    role: "compactionSummary",
    summary: fallbackSummary(details.checkpointId),
    tokensBefore: 100,
    timestamp: Date.now(),
  };
  const legacy = { ...details };
  delete legacy.retryTrimmedTail;
  assert.equal(parseCheckpointDetails(legacy)?.version, 1);
  assert.equal(projectCheckpointContext([anchor, user], legacy), undefined);
  assert.equal(projectCheckpointContext([anchor, user, tail], legacy)?.length, 1);
  assert.equal(projectCheckpointContext([anchor, user], legacy, "runtime-omitted"), undefined);
  assert.equal(projectCheckpointContext([user], details), undefined);
  assert.equal(projectCheckpointContext([anchor, tail], details), undefined);
  for (const proof of [null, "hash", {}, user, { ...tail, stopReason: "stop" }, { ...tail, timestamp: 99 }]) {
    assert.equal(parseCheckpointDetails({ ...details, retryTrimmedTail: proof }), undefined);
  }
  const userTail = detailsFor([user]);
  assert.equal(userTail.retryTrimmedTail, undefined);
  assert.equal(parseCheckpointDetails({ ...userTail, retryTrimmedTail: user }), undefined);
  assert.equal(
    parseCheckpointDetails({ ...userTail, retryTrimmedTail: { ...user, role: "assistant", stopReason: "error" } }),
    undefined,
  );
  assert.equal(detailsFor([tail], false).retryTrimmedTail, undefined);
  assert.equal(detailsFor([assistant("stop")]).retryTrimmedTail, undefined);
  assert.equal(detailsFor([tail, user]).retryTrimmedTail, undefined);
});

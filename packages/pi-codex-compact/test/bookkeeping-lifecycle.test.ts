import assert from "node:assert/strict";
import { getCurrentTools, type Model, type Tool } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { createMockContext, createMockPi, stableProvider } from "./support.js";

const model: Model<"openai-codex-responses"> = {
  id: "offline-model",
  name: "Offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64")}.x`;

function settingsRuntime(): CodexCompactSettingsRuntime {
  const state = {
    kind: "loaded" as const,
    path: "/unused/offline-settings.json",
    document: {},
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, allowCanonicalHistory: true, maxRetries: 0 },
  };
  return {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async () => assert.fail("must not change settings"),
    flush: async () => {},
  };
}

const scenarios = [
  ["before", "message"],
  ["before", "custom message"],
  ["before", "context edit"],
  ["before", "unknown custom"],
  ["before", "virtual model custom"],
  ["before", "stale leaf"],
  ["before", "null leaf"],
  ["auth", "model"],
  ["auth", "provider"],
  ["auth", "API"],
  ["auth", "base URL"],
  ["auth", "recorded prompt"],
  ["auth", "recorded tools"],
  ["flight", "recorded prompt"],
  ["flight", "recorded tools"],
  ...(["auth", "flight"] as const).flatMap((phase) =>
    (["tree", "reload", "shutdown", "caller"] as const).map((change) => [phase, change] as const),
  ),
] as const;

for (const [phase, change] of scenarios) {
  test(`Goal append cannot mask ${change} during ${phase} on an opaque boundary`, async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live HTTP"));
    vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
      throw new Error("Unexpected live WebSocket");
    });
    const manager = SessionManager.inMemory();
    const tool: Tool = { name: "inspect", description: "Inspect", parameters: Type.Object({ path: Type.String() }) };
    manager.appendMessage({
      role: "system",
      content: "Instructions",
      toolsAdded: [structuredClone(tool)],
      timestamp: 1,
    });
    manager.appendMessage({ role: "user", content: "Older task", timestamp: 2 });
    const kept = { role: "user" as const, content: "Kept task", timestamp: 3 };
    const keptId = manager.appendMessage(kept);
    const details = createCheckpointDetails({
      modelId: model.id,
      replacementHistory: [{ type: "compaction", encrypted_content: "offline-opaque" }],
      keptMessages: [kept],
    });
    const checkpointId = manager.appendCompaction(fallbackSummary(details.checkpointId), keptId, 100, details);
    const latestId = manager.appendMessage({ role: "user", content: "Latest task", timestamp: 4 });
    const input: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      // Separate snapshots prove that checking just the prepared state is insufficient.
      branchEntries: structuredClone(manager.getBranch()),
      preparation: {
        firstKeptEntryId: latestId,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    };
    const caller = new AbortController();
    input.signal = caller.signal;
    const mock = createMockPi({ activeTools: [tool.name], allTools: [tool] });
    let requests = 0;
    const retire = ["tree", "reload", "shutdown", "caller"].includes(change);
    const mutate = async () => {
      manager.appendCustomEntry("goal-state", { synthetic: true });
      if (change === "message") manager.appendMessage({ role: "user", content: "New task", timestamp: 5 });
      if (change === "custom message") manager.appendCustomMessageEntry("goal-state", "Visible", false);
      if (change === "context edit") manager.appendContextEdit(latestId, null);
      if (change === "unknown custom") manager.appendCustomEntry("unknown", {});
      if (change === "virtual model custom") manager.appendCustomEntry("pi.virtual-model-state", {});
      if (change === "stale leaf") vi.spyOn(manager, "getLeafId").mockReturnValue(latestId);
      if (change === "null leaf") vi.spyOn(manager, "getLeafId").mockReturnValue(null);
      if (change === "model") ctx.model = { ...model, id: "other" };
      if (change === "provider") ctx.model = { ...model, provider: "other" };
      if (change === "API") ctx.model = { ...model, api: "openai-responses" };
      if (change === "base URL") ctx.model = { ...model, baseUrl: "https://other.test" };
      if (change === "recorded prompt" || change === "recorded tools") {
        const checkpoint = manager.getBranch().find((entry) => entry.id === checkpointId);
        assert.ok(checkpoint?.type === "compaction" && checkpoint.systemMessage);
        if (change === "recorded prompt") checkpoint.systemMessage.content = "Different recorded instructions";
        else {
          const recorded = checkpoint.systemMessage.toolsAdded?.[0];
          assert.ok(recorded);
          recorded.parameters = Type.Object({ different: Type.Boolean() });
        }
      }
      if (change === "tree") await mock.events.get("session_tree")?.[0]({}, ctx);
      if (change === "reload") await mock.events.get("session_start")?.[0]({ reason: "reload" }, ctx);
      if (change === "shutdown") await mock.events.get("session_shutdown")?.[0]({ reason: "exit" }, ctx);
      if (change === "caller") caller.abort();
    };
    const auth = vi.fn(async () => {
      if (phase === "auth") await mutate();
      return { ok: true, apiKey };
    });
    const { ctx: mockCtx, notifications } = createMockContext({
      model,
      hasUI: true,
      sessionManager: manager,
      getSystemPrompt: () => "Instructions",
      modelRegistry: { getApiKeyAndHeaders: auth, getProvider: stableProvider(openaiCodexProvider) },
    });
    const ctx = mockCtx as ExtensionContext;
    createCodexCompactExtension({
      settingsRuntime: settingsRuntime(),
      fetch: async () => {
        requests += 1;
        if (phase === "flight") await mutate();
        const item = { type: "compaction", encrypted_content: "new-offline-opaque" };
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
        );
      },
    })(mock.pi);
    if (phase === "before") await mutate();
    assert.deepEqual(await mock.events.get("session_before_compact")?.[0](input, ctx), { cancel: true });
    assert.equal(auth.mock.calls.length, phase === "before" ? 0 : 1);
    assert.equal(requests, phase === "flight" ? 1 : 0);
    assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
    assert.deepEqual(manager.getEntries().find((entry) => entry.id === checkpointId)?.type, "compaction");
    if (retire) assert.deepEqual(notifications, [], "retired owners and caller abort stay silent");
    else {
      const warning = notifications.at(-1)?.message ?? "";
      assert.match(warning, /cancelled to preserve the existing opaque checkpoint/);
      const code = change.startsWith("recorded")
        ? phase === "auth"
          ? "loadout_mismatch"
          : "state_divergence"
        : ["model", "provider", "API", "base URL"].includes(change)
          ? "preparation_model_changed"
          : "preparation_branch_changed";
      assert.ok(warning.includes(`[${code}]`), warning);
    }
    if (change === "recorded tools") {
      assert.notDeepEqual(getCurrentTools(manager.buildSessionContext().messages), [tool]);
    }
  });
}

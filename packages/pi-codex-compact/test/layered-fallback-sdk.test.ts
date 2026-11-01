import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type AgentSession,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import {
  CHECKPOINT_VERSION,
  type CodexCheckpointDetails,
  LAYERED_CHECKPOINT_VERSION,
  layeredSummaryItem,
  layeredSummaryText,
  parseCheckpointDetails,
} from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import type { JsonObject } from "../src/protocol.js";
import { createCodexCompactSettingsRuntime } from "../src/settings.js";
import { createMockContext } from "./support.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6",
  name: "Offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://model-destination.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64")}.x`;

function sse(item: JsonObject, deltas: JsonObject[] = []): Response {
  return new Response(
    [
      ...deltas,
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: { status: "completed", output: [item] },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function textSse(text: string): Response {
  const item = {
    type: "message",
    id: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
  return sse(item, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
  ]);
}

type RequestKind = "ordinary" | "remote" | "summary";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codex-layered-sdk-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live HTTP"));
  vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
    throw new Error("Unexpected live WebSocket");
  });
  const requests: Array<{ kind: RequestKind; payload: JsonObject }> = [];
  const control: {
    remoteFails: boolean;
    summaryFails: boolean;
    summaryText: string;
    onSummary?: () => void | Promise<void>;
    onNotify?: (message: string) => void;
    onStatus?: (value: string | undefined) => void;
  } = { remoteFails: false, summaryFails: false, summaryText: "" };
  let opaque = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = init?.body;
    assert.ok(typeof body === "string" || body instanceof Uint8Array);
    const payload = JSON.parse(
      typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8"),
    ) as JsonObject;
    const kind: RequestKind = payload.input.some((item: JsonObject) => item.type === "compaction_trigger")
      ? "remote"
      : String(payload.instructions).startsWith("You are a context summarization assistant")
        ? "summary"
        : "ordinary";
    requests.push({ kind, payload });
    if (kind === "remote") {
      if (control.remoteFails)
        return new Response('{"error":{"message":"servers overloaded"}}', {
          status: 503,
        });
      opaque++;
      return sse({ type: "compaction", encrypted_content: `opaque-${opaque}` });
    }
    if (kind === "summary") {
      await control.onSummary?.();
      if (control.summaryFails)
        return new Response('{"error":{"message":"servers overloaded"}}', {
          status: 503,
          headers: { "retry-after-ms": "0" },
        });
      return textSse(control.summaryText);
    }
    return textSse("Done.");
  };
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const actual = openaiCodexProvider();
  const provider: Provider = {
    ...actual,
    getModels: () => [model],
    auth: {
      apiKey: {
        name: "Offline",
        resolve: async () => ({
          auth: {
            apiKey,
            baseUrl: "https://resolved-destination.test/backend-api/codex",
          },
        }),
      },
    },
    stream: (m, c, o) => actual.stream(m, c, { ...o, transport: "sse", fetch: o?.fetch ?? fetch }),
    streamSimple: (m, c, o) =>
      actual.streamSimple(m, c, {
        ...o,
        transport: "sse",
        fetch: o?.fetch ?? fetch,
      }),
  };
  runtime.registerNativeProvider(provider);
  const compactSettings = createCodexCompactSettingsRuntime(join(directory, "pi-codex-compact.json"));
  await compactSettings.update({ allowCanonicalHistory: true, maxRetries: 0 });
  const mock = createMockContext({ mode: "tui" });
  const rawUi = (mock.ctx as ExtensionContext).ui;
  const ui: ExtensionContext["ui"] = {
    ...rawUi,
    notify: (message, level) => {
      rawUi.notify(message, level);
      control.onNotify?.(message);
    },
    setStatus: (key, value) => {
      rawUi.setStatus(key, value);
      if (key === "codex-compact") control.onStatus?.(value);
    },
  };
  const sessions: AgentSession[] = [];
  const open = async (manager: SessionManager) => {
    const settingsManager = SettingsManager.inMemory({
      defaultTools: ["read"],
      compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 6 },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        createCodexCompactExtension({
          settingsRuntime: compactSettings,
          fetch,
        }),
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      model,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
    });
    sessions.push(session);
    await session.bindExtensions({ mode: "tui", uiContext: ui });
    return session;
  };
  return {
    directory,
    requests,
    control,
    compactSettings,
    notifications: mock.notifications,
    open,
    kindsSince: (start: number) => requests.slice(start).map((request) => request.kind),
    last: (kind: RequestKind) => requests.findLast((request) => request.kind === kind)?.payload,
    cleanup: () => {
      for (const session of sessions) session.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function compactionDetails(result: { details?: unknown }): CodexCheckpointDetails {
  const details = parseCheckpointDetails(result.details);
  assert.ok(details);
  return details;
}

/** Raw branch messages from `fromId` (inclusive) to `untilId` (exclusive). */
function messagesFrom(branch: SessionEntry[], fromId: string, untilId: string): AgentMessage[] {
  const start = branch.findIndex((entry) => entry.id === fromId);
  const end = branch.findIndex((entry) => entry.id === untilId);
  assert.ok(start >= 0 && end > start);
  return branch.slice(start, end).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/** Raw branch messages strictly after `afterId` and before `untilId`. */
function messagesBetween(branch: SessionEntry[], afterId: string, untilId: string): AgentMessage[] {
  return messagesFrom(branch, afterId, untilId).slice(
    branch.find((entry) => entry.id === afterId)?.type === "message" ? 1 : 0,
  );
}

function compactionIdFor(branch: SessionEntry[], details: CodexCheckpointDetails): string {
  const entry = branch.find(
    (candidate) =>
      candidate.type === "compaction" &&
      parseCheckpointDetails(candidate.details)?.checkpointId === details.checkpointId,
  );
  assert.ok(entry);
  return entry.id;
}

function conversation(payload: JsonObject | undefined): string {
  const text = payload?.input?.[0]?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return text;
}

function userTexts(items: JsonObject[]): string[] {
  return items.flatMap((item) =>
    item.role === "user" && layeredSummaryText(item) === undefined
      ? item.content.flatMap((part: JsonObject) => (part.type === "input_text" ? [part.text] : []))
      : [],
  );
}

/** The persisted replacement history appears contiguously, then the ordinary tail follows it. */
function replayTail(payload: JsonObject | undefined, details: CodexCheckpointDetails): JsonObject[] {
  const input = payload?.input as JsonObject[] | undefined;
  assert.ok(Array.isArray(input));
  const start = input.findIndex((item) => JSON.stringify(item) === JSON.stringify(details.replacementHistory[0]));
  assert.ok(start >= 0);
  assert.deepEqual(input.slice(start, start + details.replacementHistory.length), details.replacementHistory);
  return input.slice(start + details.replacementHistory.length);
}

function keptUserTexts(branch: SessionEntry[], firstKeptEntryId: string, compactionId: string): string[] {
  const kept = branch.slice(
    branch.findIndex((entry) => entry.id === firstKeptEntryId),
    branch.findIndex((entry) => entry.id === compactionId),
  );
  return kept.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "user" && typeof entry.message.content !== "string"
      ? entry.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : entry.type === "message" && entry.message.role === "user"
        ? [String(entry.message.content)]
        : [],
  );
}

test("SDK remote failure → layered checkpoint → exact replay → resume → merged layer → remote fold absorbs it", async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.create(f.directory, f.directory);
    let session = await f.open(manager);
    await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
    await session.prompt("Second task.");
    const first = await session.compact();
    const remote = compactionDetails(first);
    assert.equal(remote.version, CHECKPOINT_VERSION);

    await session.prompt(
      `[PI_CODEX_REMOTE_CHECKPOINT:genuine-user-content] NEWER_CANARY ${"Newer conversation content. ".repeat(100)}`,
    );
    await session.prompt("Fourth task.");
    f.control.remoteFails = true;
    f.control.summaryText = "LAYERED_SUMMARY_CANARY";
    let start = f.requests.length;
    const second = await session.compact();
    assert.deepEqual(f.kindsSince(start), ["remote", "summary"]);
    const layered = compactionDetails(second);
    assert.equal(layered.version, LAYERED_CHECKPOINT_VERSION);
    assert.deepEqual(layered.replacementHistory, [
      ...remote.replacementHistory,
      layeredSummaryItem("LAYERED_SUMMARY_CANARY"),
    ]);
    let branch = manager.getBranch();
    const remoteEntry = compactionIdFor(branch, remote);
    // Only what the remote opaque item does not already cover: after its entry, before the new kept tail.
    assert.ok(
      conversation(f.last("summary")).startsWith(
        `<conversation>\n${serializeConversation(convertToLlm(messagesBetween(branch, remoteEntry, second.firstKeptEntryId)))}\n</conversation>\n\n`,
      ),
    );
    assert.match(conversation(f.last("summary")), /NEWER_CANARY/);
    assert.match(conversation(f.last("summary")), /\[PI_CODEX_REMOTE_CHECKPOINT:genuine-user-content\]/);
    assert.match(
      f.notifications.at(-1)?.message ?? "",
      /^Codex remote compaction failed; kept the opaque checkpoint and added Pi's readable summary of newer history \(layered fallback\)\. \[remote_http_error; HTTP 503\]/,
    );

    f.control.remoteFails = false;
    await session.prompt("Fifth task.");
    const layeredEntry = compactionIdFor(manager.getBranch(), layered);
    const keptAfterLayer = keptUserTexts(manager.getBranch(), second.firstKeptEntryId, layeredEntry);
    assert.ok(keptAfterLayer.length > 0, "exercise a nonempty verbatim kept lineage");
    assert.deepEqual(userTexts(replayTail(f.last("ordinary"), layered)), [...keptAfterLayer, "Fifth task."]);

    // Resume from disk with a fresh SDK session and extension instance.
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    session.dispose();
    const resumed = SessionManager.open(sessionFile);
    session = await f.open(resumed);
    await session.prompt("Sixth task after resume.");
    assert.deepEqual(userTexts(replayTail(f.last("ordinary"), layered)), [
      ...keptAfterLayer,
      "Fifth task.",
      "Sixth task after resume.",
    ]);

    // A second failure merges into one layered summary over the same opaque item.
    await session.prompt(`Seventh task. LATER_CANARY ${"Later conversation content. ".repeat(100)}`);
    await session.prompt("Eighth task.");
    f.control.remoteFails = true;
    f.control.summaryText = "MERGED_SUMMARY_CANARY";
    start = f.requests.length;
    const third = await session.compact();
    assert.deepEqual(f.kindsSince(start), ["remote", "summary"]);
    assert.deepEqual(userTexts(replayTail(f.last("remote"), layered)).slice(0, keptAfterLayer.length), keptAfterLayer);
    const merged = compactionDetails(third);
    assert.equal(merged.version, LAYERED_CHECKPOINT_VERSION);
    assert.deepEqual(merged.replacementHistory, [
      ...remote.replacementHistory,
      layeredSummaryItem("MERGED_SUMMARY_CANARY"),
    ]);
    branch = resumed.getBranch();
    assert.ok(
      conversation(f.last("summary")).startsWith(
        `<conversation>\n${serializeConversation(
          convertToLlm([
            ...messagesFrom(branch, second.firstKeptEntryId, layeredEntry),
            ...messagesBetween(branch, layeredEntry, third.firstKeptEntryId),
          ]),
        )}\n</conversation>\n\n<previous-summary>\nLAYERED_SUMMARY_CANARY\n</previous-summary>`,
      ),
      "the layered lineage kept verbatim is summarized together with newer history",
    );

    // A healthy remote fold carries the layered history as input and supersedes it.
    f.control.remoteFails = false;
    await session.prompt("Ninth task.");
    start = f.requests.length;
    const fourth = await session.compact();
    assert.deepEqual(f.kindsSince(start), ["remote"]);
    replayTail(f.last("remote"), merged);
    const folded = compactionDetails(fourth);
    assert.equal(folded.version, CHECKPOINT_VERSION);
    assert.deepEqual(folded.replacementHistory.at(-1), {
      type: "compaction",
      encrypted_content: "opaque-2",
    });
    assert.deepEqual(
      folded.replacementHistory.filter((item) => layeredSummaryText(item) !== undefined),
      [],
      "the new opaque item absorbed the layered summary",
    );
  } finally {
    f.cleanup();
  }
});

test("SDK tools/loadout drift while the layered summary is pending cancels without replacing the opaque checkpoint", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const manager = SessionManager.create(f.directory, f.directory);
    const session = await f.open(manager);
    await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
    await session.prompt("Second task.");
    const remote = compactionDetails(await session.compact());
    await session.prompt(`Third task. ${"Newer conversation content. ".repeat(100)}`);
    await session.prompt("Fourth task.");
    const before = structuredClone(manager.getEntries());
    f.control.remoteFails = true;
    f.control.summaryText = "STALE_SUMMARY_CANARY";
    f.control.onSummary = () => {
      started.resolve();
      return release.promise;
    };
    const start = f.requests.length;
    const pending = session.compact();
    await started.promise;
    assert.deepEqual(session.getActiveToolNames(), ["read"]);
    session.setActiveToolsByName([]);
    release.resolve();
    await assert.rejects(pending, /cancel/i);
    assert.deepEqual(f.kindsSince(start), ["remote", "summary"]);
    assert.deepEqual(manager.getEntries(), before, "no stale summary or changed loadout snapshot is persisted");
    assert.equal(compactionIdFor(manager.getBranch(), remote), compactionIdFor(before, remote));
    assert.match(f.notifications.at(-1)?.message ?? "", /cancelled to preserve the existing opaque checkpoint/);
    assert.doesNotMatch(JSON.stringify(f.notifications), /STALE_SUMMARY_CANARY/);
  } finally {
    release.resolve();
    f.cleanup();
  }
});

for (const boundary of ["layered-notify", "layered-status", "remote-status"] as const) {
  test(`SDK UI ${boundary} reentrancy cannot return a stale prepared checkpoint`, async () => {
    const f = await fixture();
    try {
      const manager = SessionManager.create(f.directory, f.directory);
      const session = await f.open(manager);
      await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
      await session.prompt("Second task.");
      const remote = compactionDetails(await session.compact());
      await session.prompt(`Third task. ${"Newer conversation content. ".repeat(100)}`);
      await session.prompt("Fourth task.");
      const before = structuredClone(manager.getEntries());
      const start = f.requests.length;
      f.control.remoteFails = boundary !== "remote-status";
      f.control.summaryText = "UI_STALE_SUMMARY_CANARY";
      let mutations = 0;
      const drift = () => {
        mutations++;
        session.setActiveToolsByName([]);
      };
      if (boundary === "layered-notify") {
        f.control.onNotify = (message) => {
          if (message.startsWith("Codex remote compaction failed; kept the opaque checkpoint")) drift();
        };
      } else {
        f.control.onStatus = (value) => {
          if (value === undefined) drift();
        };
      }
      await assert.rejects(session.compact(), /cancel/i);
      assert.equal(mutations, 1, "cleanup and notification callbacks must not loop on invalidation");
      assert.deepEqual(f.kindsSince(start), boundary === "remote-status" ? ["remote"] : ["remote", "summary"]);
      assert.deepEqual(manager.getEntries(), before, "no checkpoint or changed loadout snapshot is persisted");
      assert.equal(compactionIdFor(manager.getBranch(), remote), compactionIdFor(before, remote));
    } finally {
      f.cleanup();
    }
  });
}

test("SDK provider-internal summary retries remain enabled while the complete request fence holds", async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.create(f.directory, f.directory);
    const session = await f.open(manager);
    await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
    await session.prompt("Second task.");
    await session.compact();
    await session.prompt(`Third task. ${"Newer conversation content. ".repeat(100)}`);
    await session.prompt("Fourth task.");
    await f.compactSettings.update({ maxRetries: 1 });
    f.control.remoteFails = true;
    f.control.summaryText = "Retried summary";
    let summaries = 0;
    f.control.onSummary = () => {
      f.control.summaryFails = ++summaries === 1;
    };
    const start = f.requests.length;
    const result = await session.compact();
    assert.deepEqual(f.kindsSince(start), ["remote", "remote", "summary", "summary"]);
    assert.equal(compactionDetails(result).version, LAYERED_CHECKPOINT_VERSION);
  } finally {
    f.cleanup();
  }
});

for (const drift of ["branch", "model"] as const) {
  test(`SDK ${drift} drift before a provider-internal summary retry blocks its physical fetch`, async () => {
    const f = await fixture();
    try {
      const manager = SessionManager.create(f.directory, f.directory);
      const session = await f.open(manager);
      await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
      await session.prompt("Second task.");
      const remote = compactionDetails(await session.compact());
      await session.prompt(`Third task. ${"Newer conversation content. ".repeat(100)}`);
      await session.prompt("Fourth task.");
      const checkpointIds = manager
        .getBranch()
        .filter((entry) => entry.type === "compaction")
        .map((entry) => entry.id);
      await f.compactSettings.update({ maxRetries: 1 });
      f.control.remoteFails = true;
      // The summary's 503 exercises the real SDK retry loop, after remote
      // compaction has exhausted its own one-retry budget.
      f.control.summaryFails = true;
      f.control.onSummary = async () => {
        if (drift === "branch") {
          manager.appendMessage({ role: "user", content: "Arrived during summary", timestamp: Date.now() });
        } else {
          await session.setModel({ ...model, id: "changed-model" });
        }
      };
      const start = f.requests.length;
      await assert.rejects(session.compact(), /cancel/i);
      assert.deepEqual(
        f.kindsSince(start),
        ["remote", "remote", "summary"],
        "no summary retry reaches physical fetch after drift",
      );
      assert.deepEqual(
        manager
          .getBranch()
          .filter((entry) => entry.type === "compaction")
          .map((entry) => entry.id),
        checkpointIds,
      );
      assert.ok(compactionIdFor(manager.getBranch(), remote));
      assert.match(f.notifications.at(-1)?.message ?? "", /cancelled to preserve the existing opaque checkpoint/);
    } finally {
      f.cleanup();
    }
  });
}

test("SDK native summary failure and the strict setting both cancel and preserve the opaque checkpoint", async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.create(f.directory, f.directory);
    const session = await f.open(manager);
    await session.prompt(`First task. ${"Older conversation content. ".repeat(100)}`);
    await session.prompt("Second task.");
    const remote = compactionDetails(await session.compact());
    await session.prompt(`Third task. ${"Newer conversation content. ".repeat(100)}`);
    await session.prompt("Fourth task.");
    const before = structuredClone(manager.getEntries());

    f.control.remoteFails = true;
    f.control.summaryFails = true;
    let start = f.requests.length;
    await assert.rejects(session.compact(), /cancel/i);
    assert.deepEqual(f.kindsSince(start), ["remote", "summary"]);
    assert.deepEqual(manager.getEntries(), before);
    assert.match(
      f.notifications.at(-1)?.message ?? "",
      /^Compaction cancelled to preserve the existing opaque checkpoint\. \[remote_http_error; HTTP 503\] The layered summary fallback also failed\./,
    );

    f.control.summaryFails = false;
    await f.compactSettings.update({ layeredFallback: false });
    start = f.requests.length;
    await assert.rejects(session.compact(), /cancel/i);
    assert.deepEqual(f.kindsSince(start), ["remote"], "strict mode never requests a native summary");
    assert.deepEqual(manager.getEntries(), before);
    assert.match(f.notifications.at(-1)?.message ?? "", /Layered fallback is off\./);

    await session.prompt("Continue after the cancelled compactions.");
    assert.deepEqual(
      userTexts(replayTail(f.last("ordinary"), remote)).at(-1),
      "Continue after the cancelled compactions.",
    );
  } finally {
    f.cleanup();
  }
});

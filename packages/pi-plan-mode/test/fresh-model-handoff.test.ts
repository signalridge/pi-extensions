import assert from "node:assert/strict";
import type { ExtensionCommandContext, ReplacedSessionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { formatImplementationHandoff, startFreshImplementationSession } from "../src/fresh-implementation.js";
import { createMockContext } from "./support.js";

const request = {
  plan: "Implement the approved plan.",
  source: "plan_mode_complete" as const,
  retention: "keep" as const,
  stateEntryType: "plan-mode-state",
  isCurrent: () => true,
};
const model = {
  provider: "provider-b",
  id: "model-b",
  name: "Model B",
  api: "openai-completions",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} satisfies NonNullable<ExtensionCommandContext["model"]>;

test("fresh handoff compares provider and id using only replacement context", async () => {
  for (const destination of [
    { ...model },
    { ...model, id: "model-a" },
    { ...model, provider: "provider-a" },
    undefined,
  ]) {
    let replaced = false;
    const staleAccesses: PropertyKey[] = [];
    const sent: string[] = [];
    const replacement = createMockContext({ mode: "rpc", model: destination });
    const source = createMockContext({
      mode: "rpc",
      model: { ...model },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
      sessionManager: { getSessionFile: () => "/sessions/parent.jsonl", getBranch: () => [] },
      newSession: async (options: NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>) => {
        assert.equal(options.parentSession, "/sessions/parent.jsonl");
        replaced = true;
        await options.withSession?.({
          ...(replacement.ctx as ReplacedSessionContext),
          sendUserMessage: async (message) => {
            sent.push(String(message));
          },
        });
        return { cancelled: false };
      },
    });
    const guarded = new Proxy(source.ctx as ExtensionCommandContext, {
      get(target, key, receiver) {
        if (replaced) {
          staleAccesses.push(key);
          throw new Error("stale source context");
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = await startFreshImplementationSession(guarded, {
      ...request,
      isCurrent: () => {
        assert.equal(replaced, false);
        return true;
      },
    });
    const same = destination?.provider === model.provider && destination?.id === model.id;
    assert.equal(result.kind, same ? "started" : "partial");
    assert.deepEqual(staleAccesses, []);
    assert.deepEqual(sent, same ? [formatImplementationHandoff(request.plan)] : []);
    if (!same) {
      assert.equal(replacement.editorText, formatImplementationHandoff(request.plan));
      const notification = replacement.notifications.at(-1);
      assert.equal(notification?.level, "warning");
      assert.ok(notification?.message.includes(`source ${model.provider}/${model.id}`));
      assert.ok(
        notification?.message.includes(
          destination ? `destination ${destination.provider}/${destination.id}` : "no model selected",
        ),
      );
      assert.match(notification?.message ?? "", /select or confirm the intended model, then submit/i);
    }
  }
});

test("source model changes during authentication reject before replacement", async () => {
  for (const mutation of ["replace", "mutate", "missing"] as const) {
    let release!: () => void;
    let authenticating!: () => void;
    const waiting = new Promise<void>((resolve) => {
      authenticating = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = { ...model };
    let replacementCalls = 0;
    const source = createMockContext({
      mode: "rpc",
      model: selected,
      modelRegistry: {
        getApiKeyAndHeaders: async () => {
          authenticating();
          await gate;
          return { ok: true };
        },
      },
      newSession: async () => {
        replacementCalls++;
        return { cancelled: false };
      },
    });
    const pending = startFreshImplementationSession(source.ctx, request);
    await waiting;
    if (mutation === "mutate") selected.id = "model-a";
    else
      Object.defineProperty(source.ctx, "model", {
        value: mutation === "missing" ? undefined : { ...model, id: "model-a" },
      });
    release();
    assert.equal((await pending).kind, "rejected");
    assert.equal(replacementCalls, 0);
    assert.match(source.notifications.at(-1)?.message ?? "", /model changed during authentication/i);
  }
});

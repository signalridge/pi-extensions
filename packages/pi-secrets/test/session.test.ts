import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretsSession, obfuscateRequest, restoreToolInput } from "../src/session.js";

type Messages = ContextWithSystemEvent["messages"];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(config?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "pi-secrets-request-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  if (config !== undefined) writeFileSync(join(agentDir, "pi-secrets.json"), JSON.stringify(config));
  return createSecretsSession({ env: {}, agentDir, projectConfigDir: join(root, ".pi"), projectTrusted: false });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

const value = "Ab1/".repeat(10);
const contextual = `aws_secret_access_key=${value}`;
const assistant = (args: Record<string, unknown>): Messages[number] =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name: "probe", arguments: args, thoughtSignature: "sig" }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason: "toolUse",
    timestamp: 2,
  }) as Messages[number];

describe("request-wide discovery", () => {
  it.each([
    {
      name: "separate text blocks",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: value },
            { type: "text", text: contextual },
          ],
          timestamp: 1,
        },
      ] as Messages,
    },
    {
      name: "separate messages",
      messages: [
        { role: "user", content: value, timestamp: 1 },
        { role: "user", content: contextual, timestamp: 2 },
      ] as Messages,
    },
    {
      name: "nested tool arguments",
      messages: [assistant({ bare: value, later: { list: [contextual] } })],
    },
    {
      name: "a later tool call protecting an earlier user message",
      messages: [{ role: "user", content: value, timestamp: 1 }, assistant({ later: contextual })] as Messages,
    },
  ])("protects earlier occurrences on the FIRST request across $name", ({ messages }) => {
    const state = session();
    const input = freeze(messages);
    const snapshot = structuredClone(input);
    const first = obfuscateRequest(state, input);
    expect(first.changed).toBe(true);
    expect(JSON.stringify(first.messages)).not.toContain(value);
    expect(input).toEqual(snapshot);
    expect(state.stats.lastRequestReplacements).toBe(2);
    expect(state.registry.counts().builtinPattern).toBe(1);
    const second = obfuscateRequest(state, input);
    expect(second).toEqual(first);
    expect(state.stats.lastRequestReplacements).toBe(2);
    const replay = obfuscateRequest(state, first.messages);
    expect(replay.changed).toBe(false);
    expect(replay.messages).toEqual(first.messages);
    expect(state.stats.lastRequestReplacements).toBe(0);
    expect(state.registry.counts().builtinPattern).toBe(1);
  });

  it("does not discover contextual secrets from excluded system or opaque surfaces", () => {
    const state = session();
    const input = freeze([
      { role: "system", content: contextual, timestamp: 0 },
      { role: "user", content: [{ type: "image", data: contextual, mimeType: "image/png" }], timestamp: 1 },
      {
        ...assistant({}),
        content: [{ type: "thinking", thinking: contextual, redacted: true, thinkingSignature: "opaque" }],
      },
      { role: "user", content: value, timestamp: 3 },
    ] as Messages);
    expect(obfuscateRequest(state, input)).toEqual({ messages: input, changed: false });
    expect(state.registry.counts().builtinPattern).toBe(0);
    expect(state.stats.lastRequestReplacements).toBe(0);
  });

  it("does not learn actually issued placeholders during discovery", () => {
    const state = session();
    const original: Messages = [{ role: "user", content: "https://user:Abc12345!@example.test/path", timestamp: 1 }];
    const first = obfuscateRequest(state, original);
    const counts = state.registry.counts();
    expect(counts.builtinPattern).toBe(1);
    expect(obfuscateRequest(state, first.messages)).toEqual({ messages: first.messages, changed: false });
    expect(state.registry.counts()).toEqual(counts);
    expect(state.stats.lastRequestReplacements).toBe(0);
  });

  it("keeps a pattern named after its matched secret safe, restorable and count-stable", () => {
    const secret = "ULTRASECRETPASSWORD";
    const state = session({ secrets: [{ name: secret, pattern: secret }] });
    expect(state.config.warnings).toEqual([]);
    const original: Messages = [{ role: "user", content: secret, timestamp: 1 }];
    const first = obfuscateRequest(state, original);
    const text = (first.messages[0] as Extract<Messages[number], { role: "user" }>).content;
    expect(text).toMatch(/^\$\$SECRET_[A-Z0-9]{12}\$\$$/);
    expect(JSON.stringify(first.messages)).not.toContain(secret);
    expect(state.stats.lastRequestReplacements).toBe(1);
    expect(state.registry.counts().configPattern).toBe(1);
    expect(obfuscateRequest(state, original)).toEqual(first);
    expect(obfuscateRequest(state, first.messages).changed).toBe(false);
    expect(state.stats.lastRequestReplacements).toBe(0);
    expect(state.registry.counts().configPattern).toBe(1);
    const input = { command: text };
    expect(restoreToolInput(state, input)).toBe(1);
    expect(input.command).toBe(secret);
    expect(state.stats.restoredCalls).toBe(1);
    expect(state.stats.restoredPlaceholders).toBe(1);
  });
});

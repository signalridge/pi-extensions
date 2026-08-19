/**
 * gpt-fast.test.ts — the behaviour behind the `/gpt-fast` toggle.
 *
 * The whole extension is one decision made three times a turn: should this
 * outgoing request carry `service_tier: "priority"`? Getting it wrong is not a
 * cosmetic bug. `service_tier` sent to a provider that rejects unknown fields
 * fails the entire request, which is exactly why the allowlist is exact pairs
 * rather than a prefix match — so the gate is what these tests are mostly about.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gptFast from "../src/index.js";

let agentDir: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "gpt-fast-"));
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

interface Harness {
  command: (args: string, context?: unknown) => Promise<void>;
  sessionStart: (ctx: unknown) => void;
  modelSelect: (ctx: unknown) => void;
  request: (payload: unknown, ctx: unknown) => unknown;
}

/** Fail with the missing name rather than a null-dereference three frames on. */
function required<T>(map: Map<string, T>, name: string): T {
  const found = map.get(name);
  if (found === undefined) throw new Error(`the extension never registered "${name}"`);
  return found;
}

function boot(flag = false): Harness {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  gptFast({
    registerFlag: () => {},
    registerCommand: (name: string, def: unknown) => commands.set(name, def as never),
    on: (event: string, handler: unknown) => events.set(event, handler as never),
    getFlag: () => flag,
  } as never);
  return {
    command: (args, context) => required(commands, "gpt-fast").handler(args, context ?? ctx()),
    sessionStart: (context) => void required(events, "session_start")({}, context),
    modelSelect: (context) => void required(events, "model_select")({}, context),
    request: (payload, context) => required(events, "before_provider_request")({ payload }, context),
  };
}

const notices: { message: string; level: string }[] = [];
const statuses: (string | undefined)[] = [];

function ctx(model?: { provider: string; id: string }) {
  return {
    hasUI: true,
    model,
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  };
}

const onAllowlist = { provider: "openai", id: "gpt-5.6" };
const offAllowlist = { provider: "anthropic", id: "claude-opus-5" };

beforeEach(() => {
  notices.length = 0;
  statuses.length = 0;
});

test("leaves the payload untouched while disabled", () => {
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  expect(pi.request({ model: "gpt-5.6" }, ctx(onAllowlist))).toBeUndefined();
});

test("injects the priority tier once enabled on an allowlisted model", async () => {
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  await pi.command("on");
  expect(pi.request({ model: "gpt-5.6" }, ctx(onAllowlist))).toEqual({
    model: "gpt-5.6",
    service_tier: "priority",
  });
});

// The allowlist is exact pairs, not a prefix match, because sending
// `service_tier` to a provider that rejects unknown fields fails the whole
// request — a wrong guess costs a turn rather than degrading quietly.
test("does not inject on a model that is not on the allowlist", async () => {
  const pi = boot();
  pi.sessionStart(ctx(offAllowlist));
  await pi.command("on");
  expect(pi.request({ model: "claude-opus-5" }, ctx(offAllowlist))).toBeUndefined();
});

test("does not inject for a lookalike provider on the same model id", async () => {
  const pi = boot();
  await pi.command("on");
  const lookalike = { provider: "krill", id: "gpt-5.6" };
  expect(pi.request({ model: "gpt-5.6" }, ctx(lookalike))).toBeUndefined();
});

test("does not inject when no model is selected", async () => {
  const pi = boot();
  await pi.command("on");
  expect(pi.request({ model: "x" }, ctx(undefined))).toBeUndefined();
});

test("leaves a non-object payload alone rather than spreading it", async () => {
  const pi = boot();
  await pi.command("on");
  expect(pi.request("not an object", ctx(onAllowlist))).toBeUndefined();
  expect(pi.request([1, 2], ctx(onAllowlist))).toBeUndefined();
  expect(pi.request(null, ctx(onAllowlist))).toBeUndefined();
});

test("preserves every other payload field", async () => {
  const pi = boot();
  await pi.command("on");
  const injected = pi.request({ model: "gpt-5.6", input: [1], reasoning: { effort: "high" } }, ctx(onAllowlist));
  expect(injected).toEqual({
    model: "gpt-5.6",
    input: [1],
    reasoning: { effort: "high" },
    service_tier: "priority",
  });
});

test("`off` stops injecting again", async () => {
  const pi = boot();
  await pi.command("on");
  await pi.command("off");
  expect(pi.request({ model: "gpt-5.6" }, ctx(onAllowlist))).toBeUndefined();
});

test("`toggle` and a bare invocation both flip the current state", async () => {
  const pi = boot();
  await pi.command("toggle");
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
  await pi.command("");
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeUndefined();
});

test("rejects an unrecognized argument without changing state", async () => {
  const pi = boot();
  await pi.command("on");
  await pi.command("maybe");
  expect(notices.at(-1)?.level).toBe("error");
  // Still on — a typo must not silently turn the feature off.
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
});

test("persists across a restart", async () => {
  const first = boot();
  await first.command("on");
  expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))["pi-gpt-fast"]).toEqual({
    enabled: true,
  });

  const second = boot();
  second.sessionStart(ctx(onAllowlist));
  expect(second.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
});

// pi owns this file too, so the write is read-modify-write at write time
// rather than from a cached snapshot — a stale copy would revert pi's changes.
test("preserves unrelated settings when persisting", async () => {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", "pi-gpt-fast": { other: 1 } }));
  const pi = boot();
  await pi.command("on");
  const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  expect(saved.theme).toBe("dark");
  expect(saved["pi-gpt-fast"]).toEqual({ other: 1, enabled: true });
});

test("survives a corrupt settings file instead of failing the session", () => {
  writeFileSync(join(agentDir, "settings.json"), "{ not json");
  const pi = boot();
  pi.sessionStart(ctx(onAllowlist));
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeUndefined();
});

test("the launch flag enables it without a stored setting", () => {
  const pi = boot(true);
  pi.sessionStart(ctx(onAllowlist));
  expect(pi.request({ m: 1 }, ctx(onAllowlist))).toBeDefined();
});

// "armed" is the distinction that keeps a silent no-op from looking identical
// to a working fast mode: the toggle is on, but this model gets nothing.
test("distinguishes `fast` from `fast (armed)` in the status", async () => {
  const pi = boot();
  await pi.command("on");
  statuses.length = 0;
  pi.modelSelect(ctx(onAllowlist));
  expect(statuses.at(-1)).toBe("fast");
  pi.modelSelect(ctx(offAllowlist));
  expect(statuses.at(-1)).toBe("fast (armed)");
});

test("clears the status when disabled", async () => {
  const pi = boot();
  await pi.command("on");
  statuses.length = 0;
  await pi.command("off");
  expect(statuses.at(-1)).toBeUndefined();
});

test("warns when enabled on a model the allowlist does not cover", async () => {
  const pi = boot();
  await pi.command("on", ctx(offAllowlist));
  expect(notices.at(-1)?.level).toBe("warning");
  expect(notices.at(-1)?.message).toContain("not on the priority allowlist");
});

test("confirms the model by name when enabled on an allowlisted one", async () => {
  const pi = boot();
  await pi.command("on", ctx(onAllowlist));
  expect(notices.at(-1)?.level).toBe("info");
  expect(notices.at(-1)?.message).toContain("openai/gpt-5.6");
});

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  type CodexCompactSettings,
  createCodexCompactSettingsRuntime,
  DEFAULT_CODEX_COMPACT_SETTINGS,
  effectiveStageTimeoutMs,
  loadCodexCompactSettings,
  normalizeCodexCompactSettings,
} from "../src/settings.js";

const temporaryDirectories: string[] = [];

async function tempSettingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-compact-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "pi-codex-compact.json");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("normalizes defaults and bounded user settings", () => {
  assert.deepEqual(normalizeCodexCompactSettings({}), DEFAULT_CODEX_COMPACT_SETTINGS);
  assert.deepEqual(normalizeCodexCompactSettings({ enabled: false, maxRetries: 0 }), {
    ...DEFAULT_CODEX_COMPACT_SETTINGS,
    enabled: false,
    maxRetries: 0,
  });
  assert.equal(normalizeCodexCompactSettings({ maxRetries: 3 }), undefined);
  assert.equal(normalizeCodexCompactSettings({ requestTimeoutMs: 10 }), undefined);
  assert.equal(normalizeCodexCompactSettings({ replacementTokenBudget: 1_000_000 }), undefined);
});

test("legacy injected settings remain source-compatible without the new optional stage key", () => {
  const legacy: CodexCompactSettings = {
    enabled: true,
    allowCanonicalHistory: false,
    requestTimeoutMs: 300_000,
    maxRetries: 2,
    replacementTokenBudget: 64_000,
    notifyOnFallback: true,
  };
  assert.equal(effectiveStageTimeoutMs(legacy), 300_000);
});

test("stage and whole-operation defaults are independent and explicit legacy totals stay honored", () => {
  assert.equal(normalizeCodexCompactSettings({})?.requestTimeoutMs, 900_000);
  assert.equal(normalizeCodexCompactSettings({})?.stageTimeoutMs, 300_000);
  assert.equal(normalizeCodexCompactSettings({ requestTimeoutMs: 300_000 })?.requestTimeoutMs, 300_000);
  for (const [key, max] of [
    ["requestTimeoutMs", 1_800_000],
    ["stageTimeoutMs", 600_000],
  ] as const) {
    for (const value of [30_000, max]) assert.equal(normalizeCodexCompactSettings({ [key]: value })?.[key], value);
    for (const value of [29_999, max + 1, NaN, Infinity, "300000", 30_000.5])
      assert.equal(normalizeCodexCompactSettings({ [key]: value }), undefined);
  }
});

test("loads missing and valid files without consulting real user settings", async () => {
  const path = await tempSettingsPath();
  assert.equal((await loadCodexCompactSettings(path)).kind, "missing");
  await writeFile(path, '{"enabled":false,"futureField":"kept"}\n');
  const loaded = await loadCodexCompactSettings(path);
  assert.equal(loaded.kind, "loaded");
  assert.equal(loaded.settings.enabled, false);
  assert.equal(loaded.document?.futureField, "kept");
});

test("rejects invalid, oversized, and symbolic-link settings without overwriting", async () => {
  const path = await tempSettingsPath();
  await writeFile(path, "{invalid");
  assert.equal((await loadCodexCompactSettings(path)).kind, "invalid");
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.reload();
  await assert.rejects(runtime.update({ enabled: false }), /Cannot overwrite an invalid/);
  assert.equal(await readFile(path, "utf8"), "{invalid");

  const oversized = await tempSettingsPath();
  await writeFile(oversized, JSON.stringify({ padding: "x".repeat(70 * 1024) }));
  assert.match((await loadCodexCompactSettings(oversized)).issue ?? "", /64 KiB/);

  const target = await tempSettingsPath();
  const link = await tempSettingsPath();
  await writeFile(target, "{}");
  await symlink(target, link);
  assert.match((await loadCodexCompactSettings(link)).issue ?? "", /symbolic links/);
});

test("first explicit save creates a private settings file", async () => {
  const path = await tempSettingsPath();
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.update({ enabled: false });
  assert.equal(JSON.parse(await readFile(path, "utf8")).enabled, false);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("serialized updates reread latest content, preserve unknown fields, and publish atomically", async () => {
  const path = await tempSettingsPath();
  await writeFile(path, '{"enabled":true,"external":"first"}\n');
  const runtime = createCodexCompactSettingsRuntime(path);
  await runtime.reload();
  await writeFile(path, '{"enabled":true,"external":"newer"}\n');
  await Promise.all([runtime.update({ enabled: false }), runtime.update({ maxRetries: 0 })]);
  await runtime.flush();
  const document = JSON.parse(await readFile(path, "utf8"));
  assert.equal(document.enabled, false);
  assert.equal(document.maxRetries, 0);
  assert.equal(document.external, "newer");
  assert.deepEqual(
    (await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("aborted settings operations do not publish", async () => {
  const path = await tempSettingsPath();
  const runtime = createCodexCompactSettingsRuntime(path);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.update({ enabled: false }, controller.signal), /aborted/i);
  assert.equal((await loadCodexCompactSettings(path)).kind, "missing");
});

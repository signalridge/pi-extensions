import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  createDiagnosticTrace,
  diagnosticSummary,
  flushDiagnostics,
  MAX_DIAGNOSTIC_BYTES,
  readLastDiagnostic,
  sessionCorrelation,
  validDiagnostic,
} from "../src/diagnostics.js";

const usage = {
  input: 75,
  output: 10,
  cacheRead: 20,
  cacheWrite: 5,
  totalTokens: 110,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

test("closed trace round-trips native usage, limits, phases and hashed correlation without source fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compact-trace-"));
  const path = join(dir, "trace");
  const session = `SESSION_SECRET_${randomUUID()}`;
  try {
    const trace = createDiagnosticTrace(session, "threshold", {
      path,
      operationTimeoutMs: 300_000,
      stageTimeoutMs: 60_000,
    });
    trace.phase("auth");
    trace.fold();
    trace.phase("payload");
    trace.attempt();
    trace.bytes("request", 100);
    trace.bytes("response", 200);
    trace.phase("fetch");
    trace.phase("headers");
    trace.phase("first_body");
    trace.phase("wire_terminal");
    trace.phase("provider_done");
    trace.phase("completion_wait");
    trace.usage(usage);
    trace.phase("fold_done");
    trace.finish("prepared");
    const snapshot = trace.snapshot();
    trace.phase("payload");
    trace.attempt();
    trace.usage(usage);
    trace.finish("failure", "remote_timeout");
    assert.deepEqual(trace.snapshot(), snapshot, "late progress cannot change finished traces");
    const memory = await readLastDiagnostic(session);
    assert.deepEqual(memory.at(-1), snapshot, "reader sees current outcome before async append finishes");
    await flushDiagnostics();
    const rows = await readLastDiagnostic(session, path);
    assert.deepEqual(rows.at(-1), snapshot);
    assert.equal(rows.length, 10);
    assert.equal(snapshot.input, 75);
    assert.equal(snapshot.totalCost, 10);
    assert.equal(snapshot.cacheRead, 20);
    assert.equal(snapshot.cacheWriteCost, 4);
    assert.equal(snapshot.requestBytes, 100);
    assert.equal(snapshot.responseBytes, 200);
    assert.equal(snapshot.operationTimeoutMs, 300_000);
    assert.equal(snapshot.trigger, "threshold");
    assert.equal(snapshot.session, sessionCorrelation(session));
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(rows));
    assert.ok(rows.every(validDiagnostic));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(!(await readFile(path, "utf8")).includes(session));
    assert.deepEqual(await readLastDiagnostic("other-session", path), []);
    assert.match(diagnosticSummary(snapshot), /stage\/total=60000\/300000 ms/);
    assert.equal(validDiagnostic({ ...snapshot, prompt: "SECRET" }), false);
    assert.equal(validDiagnostic({ ...snapshot, totalCost: Infinity }), false);
  } finally {
    await flushDiagnostics();
    await rm(dir, { recursive: true, force: true });
  }
});

test("throwing/mutating observers and unavailable path are disposable; cap reserves outcome", async () => {
  const options = Object.defineProperty(
    {
      observe: (row: object) => {
        Object.assign(row, { phase: "SECRET" });
        throw new Error("SECRET");
      },
    },
    "path",
    {
      get() {
        throw new Error("SECRET_PATH");
      },
    },
  );
  const trace = createDiagnosticTrace(randomUUID(), "manual", options);
  for (let i = 0; i < 200; i++) trace.phase("payload");
  trace.phase("fetch");
  trace.finish("failure", "remote_timeout", "stage");
  const snapshot = trace.snapshot();
  assert.equal(snapshot.lastPhase, "fetch");
  assert.equal(snapshot.timeoutScope, "stage");
  assert.ok(validDiagnostic(snapshot));
  assert.match(diagnosticSummary(snapshot), /timeout=stage/);
});

test("changing usage getters are read once and cannot coerce secrets into rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compact-trace-"));
  const path = join(dir, "trace");
  try {
    let inputReads = 0;
    let costReads = 0;
    const hostile = { ...usage, cost: { ...usage.cost } };
    Object.defineProperty(hostile, "input", { get: () => (++inputReads <= 2 ? 1 : "SECRET_SCALAR") });
    Object.defineProperty(hostile.cost, "total", {
      get: () => (++costReads <= 2 ? 1 : { valueOf: () => "SECRET_COERCION" }),
    });
    const trace = createDiagnosticTrace(randomUUID(), "manual", { path });
    trace.usage(hostile);
    trace.finish("prepared");
    assert.equal(inputReads, 1);
    assert.equal(costReads, 1);
    assert.ok(validDiagnostic(trace.snapshot()));
    await flushDiagnostics();
    assert.doesNotMatch(await readFile(path, "utf8"), /SECRET/);
  } finally {
    await flushDiagnostics();
    await rm(dir, { recursive: true, force: true });
  }
});

test("foreign and stale try-locks are never removed or overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compact-trace-lock-"));
  const path = join(dir, "trace");
  try {
    await writeFile(`${path}.lock`, "FOREIGN_LOCK_CANARY", { mode: 0o600 });
    const trace = createDiagnosticTrace(randomUUID(), "manual", { path });
    trace.phase("auth");
    trace.finish("prepared");
    await flushDiagnostics();
    assert.equal(await readFile(`${path}.lock`, "utf8"), "FOREIGN_LOCK_CANARY");
    await assert.rejects(stat(path), { code: "ENOENT" });
  } finally {
    await flushDiagnostics();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation freezes the trace and nonfinite native scalars are never recorded", async () => {
  const signal = new AbortController();
  const trace = createDiagnosticTrace(randomUUID(), "overflow", {
    path: "/nonexistent-parent/trace",
    signal: signal.signal,
  });
  trace.usage({ ...usage, input: NaN, cost: { ...usage.cost, total: -1 } });
  signal.abort();
  const snapshot = trace.snapshot();
  trace.phase("provider_done");
  trace.bytes("response", Infinity);
  trace.finish("prepared");
  assert.deepEqual(trace.snapshot(), snapshot);
  assert.equal(snapshot.outcome, "cancelled");
  assert.equal(snapshot.input, 0);
  assert.equal(snapshot.totalCost, 0);
  assert.ok(validDiagnostic(snapshot));
  await flushDiagnostics();
});

test("independent writers serialize the final size check at the one MiB boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compact-trace-race-"));
  const path = join(dir, "trace");
  const fixture = new URL("./diagnostic-writer.fixture.mjs", import.meta.url).pathname;
  let first: ReturnType<typeof spawn> | undefined;
  try {
    const trace = createDiagnosticTrace(randomUUID(), "manual", { path });
    trace.phase("auth");
    await flushDiagnostics();
    const [magic, line] = (await readFile(path, "utf8")).trimEnd().split("\n");
    assert.ok(magic && line);
    const filler = `${line}\n`;
    // Leave exactly one row's room. A second writer reading the same size
    // before the first append must not be able to cross the byte bound.
    const count = Math.floor(
      (MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(`${magic}\n`) - 800) / Buffer.byteLength(filler),
    );
    let initial = `${magic}\n${filler.repeat(count)}`;
    const target = MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(filler) - 100;
    initial += "\n".repeat(Math.max(0, target - Buffer.byteLength(initial)));
    await writeFile(path, initial);
    first = spawn("bun", [fixture, path, "hold"], { stdio: ["pipe", "pipe", "pipe"] });
    assert.ok(first.stdin && first.stdout && first.stderr);
    const firstExit = once(first, "exit");
    let stderr = "";
    first.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const ready = await Promise.race([
      once(first.stdout, "data"),
      firstExit.then(() => {
        throw new Error(`writer exited before barrier: ${stderr}`);
      }),
    ]);
    assert.match(String(ready[0]), /ready/);
    const second = spawn("bun", [fixture, path, "write"], { stdio: "ignore" });
    const [secondCode] = await once(second, "exit");
    assert.equal(secondCode, 0);
    first.stdin.end("release");
    const [firstCode] = await firstExit;
    assert.equal(firstCode, 0);
    assert.ok((await stat(path)).size <= MAX_DIAGNOSTIC_BYTES);
  } finally {
    first?.kill();
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);

for (const kind of [
  "symlink",
  "directory",
  "fifo",
  "hardlink",
  "unowned",
  "full",
  "malformed",
  "permissions",
] as const) {
  test(`diagnostic persistence refuses ${kind} without rewriting or deleting foreign files`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "compact-trace-"));
    const path = join(dir, "trace");
    const target = join(dir, "foreign");
    const session = randomUUID();
    try {
      await writeFile(target, "PRIVATE_CANARY", { mode: 0o600 });
      if (kind === "symlink") await symlink(target, path);
      else if (kind === "directory") await mkdir(path);
      else if (kind === "fifo") execFileSync("mkfifo", [path]);
      else if (kind === "hardlink") await link(target, path);
      else if (kind === "unowned") await writeFile(path, "PRIVATE_CANARY", { mode: 0o600 });
      else {
        const trace = createDiagnosticTrace(session, "manual", { path });
        trace.phase("auth");
        trace.finish("prepared");
        await flushDiagnostics();
        if (kind === "full") await writeFile(path, Buffer.alloc(MAX_DIAGNOSTIC_BYTES + 1, 65), { mode: 0o600 });
        if (kind === "malformed")
          await writeFile(path, '{"format":"pi-codex-compact-diagnostics-v1"}\n{"prompt":"PRIVATE_CANARY"}\n', {
            mode: 0o600,
          });
        if (kind === "permissions") await chmod(path, 0o644);
      }
      const before = kind === "directory" || kind === "fifo" ? undefined : await readFile(path);
      const trace = createDiagnosticTrace(session, "recovery", { path });
      trace.phase("auth");
      trace.finish("failure", "authentication_failed");
      await flushDiagnostics();
      if (before) assert.deepEqual(await readFile(path), before);
      assert.equal(await readFile(target, "utf8"), "PRIVATE_CANARY");
      assert.deepEqual(await readLastDiagnostic(session, path), []);
    } finally {
      await flushDiagnostics();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

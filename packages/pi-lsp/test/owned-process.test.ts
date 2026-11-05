import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { acquireClient } from "../src/client-leases.js";
import { LspClient } from "../src/lsp-client.js";
import { runDiagnostics, runFix } from "../src/runner.js";
import type { LspServerAdapter } from "../src/types.js";

const fixture = fileURLToPath(new URL("./fixtures/owned-server.mjs", import.meta.url));
const nativeKill = ChildProcess.prototype.kill;
// Windows does not allow a child to handle SIGTERM; resistance is a POSIX behavior.
const posixTest = test.skipIf(process.platform === "win32");
let root: string;
let signalledChildren: ChildProcess[];

beforeEach(() => {
  vi.setConfig({ testTimeout: 10_000 });
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  signalledChildren = kill.mock.contexts;
  root = mkdtempSync(path.join(tmpdir(), "pi-lsp-owned-process-"));
  writeFileSync(path.join(root, "main.go"), "package main\n");
});

afterEach(async () => {
  // Restore the kill seam before actual teardown, even after a failed assertion.
  const children = new Set(signalledChildren);
  if (vi.isMockFunction(ChildProcess.prototype.kill)) vi.mocked(ChildProcess.prototype.kill).mockRestore();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        nativeKill.call(child, "SIGKILL");
      });
    }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  rmSync(root, { recursive: true, force: true });
});

function adapter(scenario: string): LspServerAdapter {
  return {
    name: `owned-${scenario}`,
    isDefault: false,
    defaultCommand: { command: process.execPath, args: [fixture, scenario] },
    missingCommandHint: "Node is required for the test fixture.",
    extensions: [".go"],
    skipDirectories: new Set(),
    isSupportedFile: (file) => file.endsWith(".go"),
    languageIdFor: () => "go",
  };
}

function pids() {
  return readFileSync(path.join(root, "pids.log"), "utf8").trim().split("\n").map(Number);
}

function assertGone(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `server ${pid} must be reaped before completion`);
}

async function waitForFile(name: string) {
  const deadline = Date.now() + 3000;
  while (!existsSync(path.join(root, name))) {
    assert.ok(Date.now() < deadline, `fixture did not write ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertClosed(child: ChildProcess) {
  assert.ok(child.stdin?.destroyed);
  assert.ok(child.stdout?.destroyed);
  assert.ok(child.stderr?.destroyed);
  assert.ok(child.stdin?.closed);
  assert.ok(child.stdout?.closed);
  assert.ok(child.stderr?.closed);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
}

posixTest("initialization timeout reaps a TERM-resistant server before diagnostics completes", async () => {
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  const labels: Array<string | undefined> = [];
  const server = adapter("silent-initialize");
  const started = Date.now();
  await assert.rejects(
    runDiagnostics(
      server,
      { root, paths: ["main.go"] },
      300,
      undefined,
      { ui: { setStatus: (_key, label) => labels.push(label) } },
      "owned",
    ),
    /request timed out: initialize/,
  );
  assert.ok(Date.now() - started < 3000, "cleanup must not wait indefinitely for SIGTERM");
  pids().forEach(assertGone);
  assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
  kill.mock.contexts.forEach(assertClosed);
  assert.equal(labels.at(-1), undefined);
});

posixTest("shutdown timeout escalates to KILL and awaits the owned child", async () => {
  const server = adapter("silent-shutdown");
  const client = new LspClient(server, server.defaultCommand, root, 300);
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  try {
    await client.start();
    await client.initialize(root);
    const shutdown = client.shutdown();
    await waitForFile("shutdown.flag");
    process.kill(pids()[0], 0);
    await shutdown;
    pids().forEach(assertGone);
    assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
    kill.mock.contexts.forEach(assertClosed);
  } finally {
    client.close();
    await client.shutdown();
  }
});

posixTest("protocol failure uses the same bounded cleanup and preserves the original error", async () => {
  const server = adapter("malformed");
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  await assert.rejects(
    runDiagnostics(server, { root, paths: ["main.go"] }, 5000, undefined, { ui: { setStatus() {} } }, "owned"),
    /invalid JSON-RPC data/,
  );
  pids().forEach(assertGone);
  assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
  kill.mock.contexts.forEach(assertClosed);
});

posixTest("repeated close and concurrent restart/shutdown cannot terminate or clear the next child", async () => {
  const server = adapter("silent-initialize");
  const client = new LspClient(server, server.defaultCommand, root, 5000);
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  try {
    await client.start();
    const initialization = assert.rejects(client.initialize(root), /request cancelled/);
    await waitForFile("initialize.flag");
    assert.equal(client.close(), undefined, "close retains its synchronous signature");
    client.close();
    const oldShutdown = client.shutdown();
    const restarted = client.start();
    const duplicateStart = assert.rejects(client.start(), /already started/);
    await Promise.all([initialization, oldShutdown, restarted, duplicateStart]);
    await waitForSecondPid();
    const [oldPid, newPid] = pids();
    assertGone(oldPid);
    process.kill(newPid, 0);
    assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
    assert.equal(kill.mock.contexts[0], kill.mock.contexts[1]);
    // Allow any stale escalation to fire; it must neither kill nor clear the new child.
    await new Promise((resolve) => setTimeout(resolve, 600));
    process.kill(newPid, 0);
    const pending = assert.rejects(client.initialize(root), /request cancelled/);
    client.close();
    await Promise.all([pending, client.shutdown()]);
    pids().forEach(assertGone);
    assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"], ["SIGTERM"], ["SIGKILL"]]);
    assert.notEqual(kill.mock.contexts[0], kill.mock.contexts[2]);
    kill.mock.contexts.forEach(assertClosed);
  } finally {
    client.close();
    await client.shutdown();
  }
});

posixTest.each(["false", "throw EPERM", "emit EPERM", "true without signal"] as const)(
  "failed termination (%s) settles shutdown/restart but retains the live child until close",
  async (failure) => {
    const server = adapter("silent-initialize");
    const client = new LspClient(server, server.defaultCommand, root, 5000);
    const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess) {
      if (failure === "false") return false;
      if (failure === "true without signal") return true;
      const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      if (failure === "throw EPERM") throw error;
      this.emit("error", error);
      return false;
    });
    await client.start();
    const initialization = assert.rejects(client.initialize(root), /request cancelled/);
    await waitForFile("initialize.flag");
    const started = Date.now();
    assert.equal(client.close(), undefined);
    client.close();
    let cleanupError: Error | undefined;
    const message =
      failure === "true without signal"
        ? /No close within 500 ms after SIGKILL/
        : failure === "false"
          ? /SIGKILL: kill returned false/
          : /SIGKILL: kill EPERM/;
    await Promise.all([
      initialization,
      assert.rejects(client.shutdown(), (error: Error) => {
        cleanupError = error;
        assert.match(error.message, message);
        assert.match(error.message, /termination is unconfirmed; restart is blocked until close/);
        return true;
      }),
      assert.rejects(client.start(), message),
    ]);
    assert.ok(Date.now() - started < 1500, "known kill failure must settle within the escalation bound");
    assert.equal(pids().length, 1, "failure must not launch a replacement");
    const child = kill.mock.contexts[0];
    process.kill(pids()[0], 0);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
    assert.equal(kill.mock.contexts[1], child);
    child.emit("error", new Error("late process error"));
    client.close();
    await assert.rejects(client.shutdown(), (error) => error === cleanupError);
    await assert.rejects(client.start(), (error) => error === cleanupError);
    assert.equal(kill.mock.calls.length, 2, "close and late errors must not retry signals");

    // Completion was failure, not reaping. Restore native kill to confirm close.
    kill.mockRestore();
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      nativeKill.call(child, "SIGKILL");
    });
    assertGone(child.pid as number);
    await client.shutdown();
    const replacementKill = vi.spyOn(ChildProcess.prototype, "kill");
    signalledChildren = replacementKill.mock.contexts;
    try {
      await client.start();
      await waitForSecondPid();
      await new Promise((resolve) => setTimeout(resolve, 600));
      process.kill(pids()[1], 0);
      assert.equal(replacementKill.mock.calls.length, 0, "old cleanup cannot signal the replacement");
    } finally {
      client.close();
      await client.shutdown();
    }
    assert.deepEqual(replacementKill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
    assert.notEqual(replacementKill.mock.contexts[0], child);
    pids().forEach(assertGone);
  },
);

posixTest.each(["diagnostics", "fix"] as const)(
  "%s preserves protocol/request errors and clears status when owned cleanup fails",
  async (kind) => {
    const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess) {
      this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
      return false;
    });
    for (const scenario of ["malformed", "silent-initialize"]) {
      const server = adapter(scenario);
      const labels: Array<string | undefined> = [];
      const ctx = { ui: { setStatus: (_key: string, label: string | undefined) => labels.push(label) } };
      const started = Date.now();
      const running =
        kind === "diagnostics"
          ? runDiagnostics(server, { root, paths: ["main.go"] }, 300, undefined, ctx, "owned")
          : runFix(server, { root, path: "main.go" }, 300, undefined, ctx, "owned");
      await assert.rejects(running, scenario === "malformed" ? /invalid JSON-RPC data/ : /timed out: initialize/);
      assert.ok(Date.now() - started < 2000);
      assert.equal(labels.at(-1), undefined);
    }
    assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"], ["SIGTERM"], ["SIGKILL"]]);
    pids().forEach((pid) => {
      process.kill(pid, 0);
    });
    // afterEach restores native kill and reaps these still-live owned fixtures.
  },
);

posixTest.each(["diagnostics", "fix"] as const)(
  "%s reports failed cleanup when the tool operation itself succeeded",
  async (kind) => {
    const server = adapter("clean");
    const labels: Array<string | undefined> = [];
    const ctx = { ui: { setStatus: (_key: string, label: string | undefined) => labels.push(label) } };
    vi.spyOn(ChildProcess.prototype, "kill").mockReturnValue(false);
    const running =
      kind === "diagnostics"
        ? runDiagnostics(server, { root, paths: ["main.go"] }, 300, undefined, ctx, "owned")
        : runFix(server, { root, path: "main.go" }, 300, undefined, ctx, "owned");
    await assert.rejects(running, /cleanup failed: SIGTERM: kill returned false; SIGKILL: kill returned false/);
    assert.equal(labels.at(-1), undefined);
    process.kill(pids()[0], 0);
  },
);

posixTest("a TERM error still escalates successfully without reporting cleanup failure", async () => {
  const server = adapter("responsive");
  const client = new LspClient(server, server.defaultCommand, root, 5000);
  const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
    if (signal === "SIGTERM") {
      this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
      return false;
    }
    return nativeKill.call(this, signal);
  });
  try {
    await client.start();
    await client.initialize(root);
    client.close();
    await client.shutdown();
    assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
    pids().forEach(assertGone);
  } finally {
    client.close();
    await client.shutdown();
  }
});

async function waitForSecondPid() {
  const deadline = Date.now() + 3000;
  while (pids().length < 2) {
    assert.ok(Date.now() < deadline, "restart did not spawn the second server");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

posixTest("abort reaps diagnostics and fix children and clears request/diagnostic timers before status", async () => {
  const schedule = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  for (const phase of ["initialize", "didOpen"]) {
    const server = adapter(phase === "initialize" ? "silent-initialize" : "responsive");
    for (const kind of ["diagnostics", "fix"] as const) {
      rmSync(path.join(root, `${phase}.flag`), { force: true });
      const controller = new AbortController();
      const ctx = {
        ui: {
          setStatus: (_key: string, label: string | undefined) => {
            if (label === undefined) pids().forEach(assertGone);
          },
        },
      };
      const running =
        kind === "diagnostics"
          ? runDiagnostics(server, { root, paths: ["main.go"] }, 5000, controller.signal, ctx, "owned")
          : runFix(server, { root, path: "main.go" }, 5000, controller.signal, ctx, "owned");
      const rejected = assert.rejects(running, /request cancelled/);
      await waitForFile(`${phase}.flag`);
      controller.abort();
      await rejected;
      pids().forEach(assertGone);
    }
  }
  assert.equal(pids().length, 4);
  schedule.mock.calls.forEach(([, ms], index) => {
    if (ms !== 5000) return;
    const timer = schedule.mock.results[index].value;
    assert.ok(
      clear.mock.calls.some(([cleared]) => cleared === timer),
      "abort must dispose each pending timer",
    );
  });
});

test("abort immediately after spawn prevents initialize and still awaits cleanup", async () => {
  const server = adapter("silent-initialize");
  const controller = new AbortController();
  const start = LspClient.prototype.start;
  vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: LspClient) {
    await start.call(this);
    controller.abort();
  });
  const initialize = vi.spyOn(LspClient.prototype, "initialize");
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  await assert.rejects(
    runDiagnostics(server, { root, paths: ["main.go"] }, 5000, controller.signal, { ui: { setStatus() {} } }, "owned"),
    /request aborted/,
  );
  assert.equal(initialize.mock.calls.length, 0);
  assert.ok(kill.mock.contexts.length > 0);
  kill.mock.contexts.forEach((child) => {
    assertClosed(child);
    assertGone(child.pid as number);
  });
});

test("failed spawn without a PID releases ownership and permits restart", async () => {
  const server = adapter("cooperative");
  const cwd = path.join(root, "missing");
  const client = new LspClient(server, server.defaultCommand, cwd, 5000);
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  try {
    await assert.rejects(client.start(), /process failed to start/);
    await client.shutdown();
    assert.equal(kill.mock.calls.length, 0);
    mkdirSync(cwd);
    await client.start();
    await client.initialize(cwd);
    await client.shutdown();
    kill.mock.contexts.forEach(assertClosed);
  } finally {
    client.close();
    await client.shutdown();
  }
});

posixTest("confirmed exit cancels the escalation timer and destroys all owned streams", async () => {
  const server = adapter("cooperative");
  const client = new LspClient(server, server.defaultCommand, root, 5000);
  const kill = vi.spyOn(ChildProcess.prototype, "kill");
  const schedule = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  try {
    await client.start();
    await client.initialize(root);
    client.close();
    await client.shutdown();
    const escalationIndex = schedule.mock.calls.findIndex(([, ms]) => ms === 500);
    assert.ok(escalationIndex >= 0);
    const timer = schedule.mock.results[escalationIndex].value;
    assert.ok(
      clear.mock.calls.some(([cleared]) => cleared === timer),
      "exit must clear the escalation timer",
    );
    assert.deepEqual(kill.mock.calls, [["SIGTERM"]]);
    kill.mock.contexts.forEach(assertClosed);
    pids().forEach(assertGone);
  } finally {
    client.close();
    await client.shutdown();
  }
});

posixTest.each(["pending", "failed"] as const)(
  "admission rescans active A after waiting for closing B while A's cleanup is %s",
  async (phase) => {
    const server = adapter("responsive");
    const a = await acquireClient(server, root, 5000);
    await a.client.start();
    await a.client.initialize(root);
    // An active equivalent client must not serialize a legitimate concurrent call.
    const b = await acquireClient(server, root, 5000);
    await b.client.start();
    await b.client.initialize(root);
    assert.equal(pids().length, 2);
    let delayedChild: ChildProcess | undefined;
    let failingChild: ChildProcess | undefined;
    const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
      delayedChild ??= this;
      if (this === delayedChild) return true;
      failingChild ??= this;
      if (this === failingChild) return false;
      return nativeKill.call(this, signal);
    });
    let third: Awaited<ReturnType<typeof acquireClient>> | undefined;
    let unrelated: Awaited<ReturnType<typeof acquireClient>> | undefined;
    try {
      b.client.close();
      b.releaseWhenClosed();
      let waitingForB!: () => void;
      const waiting = new Promise<void>((resolve) => {
        waitingForB = resolve;
      });
      const wait = b.client.waitForTermination;
      vi.spyOn(b.client, "waitForTermination").mockImplementation(() => {
        waitingForB();
        return wait.call(b.client);
      });
      const started = Date.now();
      const rejected = assert.rejects(
        acquireClient(server, root, 5000).then(async (lease) => {
          third = lease;
          await lease.client.start();
        }),
        /termination is unconfirmed/,
      );
      await waiting;
      a.client.close();
      a.releaseWhenClosed();
      const failed = assert.rejects(a.client.shutdown(), /SIGKILL: kill returned false/);

      // The waiting key cannot block a different root's admission or native child.
      const otherRoot = path.join(root, "independent");
      mkdirSync(otherRoot);
      unrelated = await acquireClient(server, otherRoot, 5000);
      await unrelated.client.start();
      await unrelated.client.initialize(otherRoot);
      if (phase === "failed") await failed;
      assert.ok(delayedChild);
      assert.ok(failingChild);
      process.kill(failingChild.pid as number, 0);
      await new Promise<void>((resolve) => {
        delayedChild?.once("close", () => resolve());
        nativeKill.call(delayedChild, "SIGKILL");
      });
      await Promise.all([failed, rejected]);
      assert.ok(Date.now() - started < 2000, "failed cleanup must reject admission within its bound");
      assert.equal(third, undefined, "the rescan must happen before registering or spawning C");
      assert.equal(pids().length, 2, "no replacement may start on the guarded root");
      assertGone(delayedChild.pid as number);
      process.kill(failingChild.pid as number, 0);
    } finally {
      const owned = [a, b, third, unrelated].filter((lease) => lease !== undefined);
      for (const lease of owned) lease.client.close();
      await Promise.allSettled(owned.map((lease) => lease.client.shutdown()));
      for (const lease of owned) lease.releaseWhenClosed();
      assert.ok(kill.mock.contexts.length > 0);
    }
  },
);

posixTest.each(["root alias", "launcher alias", "inherited PATH", "undefined override"] as const)(
  "runner identity cannot bypass unconfirmed closure with an equivalent %s",
  async (variant) => {
    symlinkSync(process.execPath, path.join(root, "server"));
    symlinkSync("server", path.join(root, "launcher-alias"));
    const rootAlias = path.join(root, "root-alias");
    symlinkSync(root, rootAlias, "dir");
    const server = adapter("silent-initialize");
    server.defaultCommand = { ...server.defaultCommand, command: "./server" };
    const kill = vi.spyOn(ChildProcess.prototype, "kill").mockReturnValue(false);
    const ctx = { ui: { setStatus() {} } };
    await assert.rejects(
      runDiagnostics(server, { root, paths: ["main.go"] }, 150, undefined, ctx, "owned"),
      /timed out/,
    );
    const equivalent = { ...server };
    if (variant === "launcher alias") {
      equivalent.defaultCommand = { ...server.defaultCommand, command: "./launcher-alias" };
    }
    if (variant === "inherited PATH") equivalent.env = { PATH: process.env.PATH ?? "" };
    if (variant === "undefined override") {
      // JSON validation rejects this value, but an internal adapter must still
      // match the effective spawn environment: undefined absent keys are omitted.
      equivalent.env = { PI_LSP_UNSET_TEST: undefined } as unknown as Record<string, string>;
    }
    await assert.rejects(
      runFix(
        equivalent,
        { root: variant === "root alias" ? rootAlias : root, path: "main.go" },
        150,
        undefined,
        ctx,
        "owned",
      ),
      /termination is unconfirmed/,
    );
    assert.equal(pids().length, 1, "equivalent launcher and effective environment must never spawn a replacement");
    assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
    process.kill(pids()[0], 0);
  },
);

posixTest("lease identity and spawn share a frozen effective environment, not mutable raw overrides", async () => {
  vi.stubEnv("PI_LSP_TEST_INHERITED", "inherited-before");
  vi.stubEnv("PI_LSP_TEST_REMOVED", "remove-me");
  const server = adapter("environment");
  server.env = {
    PI_LSP_TEST_OVERRIDE: "configured-before",
    PI_LSP_TEST_REMOVED: undefined,
  } as unknown as Record<string, string>;
  const owned: Array<Awaited<ReturnType<typeof acquireClient>>> = [];
  try {
    const first = await acquireClient(server, root, 5000);
    owned.push(first);
    vi.stubEnv("PI_LSP_TEST_INHERITED", "inherited-after");
    server.env.PI_LSP_TEST_OVERRIDE = "configured-after";
    await first.client.start();
    await first.client.initialize(root);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "environment.json"), "utf8")), {
      inherited: "inherited-before",
      override: "configured-before",
    });
    vi.spyOn(ChildProcess.prototype, "kill").mockReturnValue(false);
    first.client.close();
    first.releaseWhenClosed();
    await assert.rejects(first.client.shutdown(), /termination is unconfirmed/);
    const original = {
      ...server,
      env: {
        PI_LSP_TEST_INHERITED: "inherited-before",
        PI_LSP_TEST_OVERRIDE: "configured-before",
        PI_LSP_TEST_REMOVED: undefined,
      } as unknown as Record<string, string>,
    };
    await assert.rejects(acquireClient(original, root, 5000), /termination is unconfirmed/);

    // A genuinely different inherited environment is an independent key.
    const changed = await acquireClient(
      { ...server, env: { ...server.env, PI_LSP_TEST_OVERRIDE: "configured-before" } },
      root,
      5000,
    );
    owned.push(changed);
    await changed.client.start();
    await changed.client.initialize(root);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "environment.json"), "utf8")), {
      inherited: "inherited-after",
      override: "configured-before",
    });
    assert.equal(pids().length, 2);
  } finally {
    for (const lease of owned) lease.client.close();
    await Promise.allSettled(owned.map((lease) => lease.client.shutdown()));
    for (const lease of owned) lease.releaseWhenClosed();
    vi.unstubAllEnvs();
  }
});

for (const firstKind of ["diagnostics", "fix"] as const) {
  posixTest.each(["false", "throw EPERM", "emit EPERM", "true without signal"] as const)(
    `runner retains ${firstKind} leases across calls after %s until confirmed close`,
    async (failure) => {
      const server = adapter("silent-initialize");
      server.env = { PI_LSP_TEST_READY: path.join(root, "silent.ready") };
      const labels: Array<string | undefined> = [];
      const ctx = { ui: { setStatus: (_key: string, label: string | undefined) => labels.push(label) } };
      let blockedChild: ChildProcess | undefined;
      const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
        blockedChild ??= this;
        if (this !== blockedChild) return nativeKill.call(this, signal);
        if (failure === "true without signal") return true;
        if (failure === "false") return false;
        const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        if (failure === "throw EPERM") throw error;
        this.emit("error", error);
        return false;
      });
      let expectedReady: string | undefined;
      const start = LspClient.prototype.start;
      vi.spyOn(LspClient.prototype, "start").mockImplementation(async function (this: LspClient) {
        const ready = expectedReady;
        if (ready) rmSync(ready, { force: true });
        await start.call(this);
        if (ready) await waitForFile(path.relative(root, ready));
      });
      const invoke = async (kind: "diagnostics" | "fix", target = server, directory = root) => {
        // Stable per-adapter readiness paths preserve effective-environment lease
        // identity, including aliases and calls blocked before actual spawning.
        expectedReady = target.env?.PI_LSP_TEST_READY;
        try {
          return await (kind === "diagnostics"
            ? runDiagnostics(target, { root: directory, paths: ["main.go"] }, 150, undefined, ctx, "shared-status")
            : runFix(target, { root: directory, path: "main.go" }, 150, undefined, ctx, "shared-status"));
        } finally {
          expectedReady = undefined;
        }
      };
      const started = Date.now();
      await assert.rejects(invoke(firstKind), /timed out: initialize/, "preserve the request error");
      assert.ok(Date.now() - started < 2000, "unconfirmed cleanup must be bounded");
      assert.equal(labels.at(-1), undefined);
      assert.equal(pids().length, 1);
      assert.ok(blockedChild);
      const oldChild = blockedChild;
      const otherKind = firstKind === "diagnostics" ? "fix" : "diagnostics";
      await assert.rejects(invoke(otherKind, { ...server }), /termination is unconfirmed/);
      await assert.rejects(invoke(firstKind), /termination is unconfirmed/);
      const alias = path.join(root, "root-alias");
      symlinkSync(root, alias, "dir");
      await assert.rejects(invoke(otherKind, { ...server }, alias), /termination is unconfirmed/);
      assert.equal(pids().length, 1, "equivalent calls, including real-root aliases, must not spawn another child");
      assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
      process.kill(pids()[0], 0);

      // A different actual adapter on the same root is independent, even when
      // callers use the same status key. Same adapter on another root is too.
      const clean = adapter("clean");
      clean.env = { PI_LSP_TEST_READY: path.join(root, "clean.ready") };
      await invoke(otherKind, clean);
      assert.equal(pids().length, 2);
      assertGone(pids()[1]);
      const otherRoot = path.join(root, "other-root");
      mkdirSync(otherRoot);
      writeFileSync(path.join(otherRoot, "main.go"), "package main\n");
      await assert.rejects(invoke(otherKind, server, otherRoot), /timed out: initialize/);
      const otherPid = Number(readFileSync(path.join(otherRoot, "pids.log"), "utf8").trim());
      assertGone(otherPid);
      await assert.rejects(invoke(otherKind), /termination is unconfirmed/);

      // Restore native signalling only for fixture teardown; no historical PID
      // is used to signal. The runner releases its lease solely on this close.
      kill.mockRestore();
      await new Promise<void>((resolve) => {
        oldChild.once("close", () => resolve());
        nativeKill.call(oldChild, "SIGKILL");
      });
      assertGone(oldChild.pid as number);
      const replacementKill = vi.spyOn(ChildProcess.prototype, "kill");
      signalledChildren = replacementKill.mock.contexts;
      await assert.rejects(invoke(otherKind), /timed out: initialize/);
      assert.equal(pids().length, 3, "confirmed close permits a replacement invocation");
      assert.notEqual(replacementKill.mock.contexts[0], oldChild);
      pids().forEach(assertGone);
      // A late old-child error/close must not interfere with a new lease.
      oldChild.emit("error", new Error("late old-child error"));
      oldChild.emit("close", null, "SIGKILL");
      await assert.rejects(invoke(firstKind), /timed out: initialize/);
      assert.equal(pids().length, 4);
      pids().forEach(assertGone);
    },
  );
}

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import * as adapters from "../src/adapters.js";
import { LspClient } from "../src/lsp-client.js";
import extension from "../src/pi-lsp.js";
import { LspSessionScope } from "../src/session-lifecycle.js";
import type { LspServerAdapter } from "../src/types.js";
import { createMockContext, createMockPi } from "./support.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function harness(hang?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "lsp-session-"));
  const file = path.join(root, "main.go");
  const log = path.join(root, "events.jsonl");
  writeFileSync(file, "package main\n");
  writeFileSync(log, "");
  const adapter: LspServerAdapter = {
    name: "fixture",
    isDefault: false,
    defaultCommand: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/lifecycle-server.mjs", import.meta.url)), hang ?? "never", log],
    },
    extensions: [".go"],
    skipDirectories: new Set(),
    missingCommandHint: "",
    isSupportedFile: (name) => name.endsWith(".go"),
    languageIdFor: () => "go",
  };
  // These cases exercise explicit cancellation within a 10s test deadline.
  // A shorter transport deadline can win before the real-child readiness event
  // is observed under suite load, testing a timeout instead of lifecycle drain.
  vi.spyOn(adapters, "loadRuntime").mockReturnValue({ adapters: [adapter], timeoutMs: 30_000 });
  const mock = createMockPi();
  extension(mock.pi);
  const controller = new AbortController();
  const statuses: Array<string | undefined> = [];
  let stale = false;
  let staleAccesses = 0;
  const base = createMockContext({ cwd: root, mode: "tui", sessionManager: { getSessionId: () => "one" } }).ctx;
  const ctx = Object.create(base, {
    ui: {
      get() {
        if (stale) {
          staleAccesses++;
          throw new Error("stale SDK context");
        }
        return {
          setStatus(_key: string, value: string | undefined) {
            statuses.push(value);
          },
          notify() {},
        };
      },
    },
    mode: {
      get() {
        if (stale) {
          staleAccesses++;
          throw new Error("stale mode");
        }
        return "tui";
      },
    },
  });
  const tasks: Promise<unknown>[] = [];
  function execute(kind: "diagnostics" | "fix", target = ctx, params = {}) {
    const tool = mock.tools.find((tool) => tool.name === `lsp_${kind}`);
    assert.ok(tool);
    const task = (tool.execute as (...args: unknown[]) => Promise<unknown>)(
      "test",
      {
        paths: [file],
        path: file,
        write: true,
        ...params,
      },
      controller.signal,
      undefined,
      target,
    );
    tasks.push(task);
    void task.catch(() => {});
    return task;
  }
  async function emit(name: string, target = ctx) {
    for (const handler of mock.events.get(name) ?? []) await handler({ type: name, reason: "reload" }, target);
  }
  function records(): Array<{ method: string; pid: number }> {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  function ready(method: string) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(deadline);
        unwatchFile(log, check);
      };
      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error(`Fixture never reached ${method}; records: ${JSON.stringify(records())}`));
      }, 5_000);
      function check() {
        if (records().some((record) => record.method === method)) {
          cleanup();
          resolve();
        }
      }
      // Native fs.watch can coalesce/drop append notifications on macOS. Stat
      // watching observes the persistent readiness record instead of requiring
      // one particular edge; keep the wait bounded and remove its listener.
      watchFile(log, { interval: 20, persistent: false }, check);
      check();
    });
  }
  function exited() {
    const entries = records();
    assert.ok(entries.length);
    for (const pid of new Set(entries.map((entry) => entry.pid))) {
      assert.ok(entries.some((entry) => entry.pid === pid && entry.method === "exited"));
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    }
  }
  return {
    root,
    file,
    log,
    adapter,
    controller,
    ctx,
    base,
    statuses,
    tasks,
    execute,
    emit,
    ready,
    records,
    exited,
    stale: () => {
      stale = true;
    },
    get staleAccesses() {
      return staleAccesses;
    },
    async dispose() {
      controller.abort();
      await Promise.allSettled(tasks);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function fakeClients() {
  vi.spyOn(LspClient.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "didOpen").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "didClose").mockImplementation(() => false);
  vi.spyOn(LspClient.prototype, "diagnostics").mockResolvedValue([]);
  vi.spyOn(LspClient.prototype, "codeActions").mockResolvedValue([]);
  vi.spyOn(LspClient.prototype, "resolveActions").mockImplementation(async (actions) => actions);
  vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue(undefined);
  return vi.spyOn(LspClient.prototype, "close").mockImplementation(() => {});
}

for (const kind of ["diagnostics", "fix"] as const) {
  for (const method of [
    "initialize",
    "textDocument/diagnostic",
    ...(kind === "fix" ? ["textDocument/codeAction", "codeAction/resolve"] : []),
    "shutdown",
  ]) {
    test(`real ${kind}: session shutdown drains child during ${method}`, async () => {
      const f = harness(method);
      try {
        await f.emit("session_start");
        const task = f.execute(kind);
        await f.ready(method);
        await f.emit("session_shutdown");
        f.stale();
        await assert.rejects(task, /aborted|cancelled/);
        f.exited();
        assert.equal(
          readFileSync(f.file, "utf8"),
          method === "shutdown" && kind === "fix" ? "// fixed\npackage main\n" : "package main\n",
        );
        assert.equal(f.staleAccesses, 0);
        assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
        assert.equal(f.statuses.at(-1), undefined);
      } finally {
        await f.dispose();
      }
    }, 10_000);
  }
}

for (const kind of ["diagnostics", "fix"] as const) {
  for (const method of [
    "start",
    "initialize",
    "diagnostics",
    ...(kind === "fix" ? (["codeActions", "resolveActions"] as const) : []),
  ] as const) {
    test(`fake ${kind}: shutdown after ${method} response prevents continuation`, async () => {
      const f = harness();
      fakeClients();
      const held = gate();
      const entered = gate();
      const original = vi.mocked(LspClient.prototype[method]).getMockImplementation();
      assert.ok(original);
      vi.spyOn(LspClient.prototype, method).mockImplementation(async function (this: LspClient, ...args: unknown[]) {
        const result = await (original as (...values: unknown[]) => Promise<unknown>).apply(this, args);
        entered.release();
        await held.promise;
        return result;
      } as never);
      try {
        const task = f.execute(kind);
        await entered.promise;
        const stopping = f.emit("session_shutdown");
        f.stale();
        held.release();
        await stopping;
        await assert.rejects(task, /aborted|cancelled/);
        assert.equal(f.staleAccesses, 0);
        const next = {
          start: "initialize",
          initialize: "didOpen",
          diagnostics: "codeActions",
          codeActions: "resolveActions",
          resolveActions: "never",
        }[method];
        if (next !== "never") assert.equal(vi.mocked(LspClient.prototype[next as "initialize"]).mock.calls.length, 0);
        assert.equal(readFileSync(f.file, "utf8"), "package main\n");
      } finally {
        held.release();
        await f.dispose();
      }
    });
  }
}

test("shutdown after the first route cannot start a second server", async () => {
  const f = harness();
  fakeClients();
  vi.mocked(adapters.loadRuntime).mockReturnValue({
    adapters: [f.adapter, { ...f.adapter, name: "second" }],
    timeoutMs: 1_000,
  });
  const entered = gate();
  const held = gate();
  vi.mocked(LspClient.prototype.shutdown).mockImplementation(async () => {
    entered.release();
    await held.promise;
  });
  try {
    const task = f.execute("diagnostics");
    await entered.promise;
    const stopping = f.emit("session_shutdown");
    held.release();
    await stopping;
    await assert.rejects(task, /aborted|cancelled/);
    assert.equal(vi.mocked(LspClient.prototype.start).mock.calls.length, 1);
  } finally {
    held.release();
    await f.dispose();
  }
});

test("queued mutation is cancelled before admission and never spawns or writes", async () => {
  const f = harness();
  fakeClients();
  const held = gate();
  const entered = gate();
  const occupying = withFileMutationQueue(f.file, async () => {
    entered.release();
    await held.promise;
  });
  try {
    await entered.promise;
    const task = f.execute("fix");
    const stopping = f.emit("session_shutdown");
    writeFileSync(f.file, "external save\n");
    held.release();
    await occupying;
    await stopping;
    await assert.rejects(task, /aborted/);
    assert.equal(vi.mocked(LspClient.prototype.start).mock.calls.length, 0);
    assert.equal(readFileSync(f.file, "utf8"), "external save\n");
  } finally {
    held.release();
    await occupying;
    await f.dispose();
  }
});

test("concurrent sessions sharing UI retain separate invocation ownership", async () => {
  const f = harness();
  const close = fakeClients();
  const entered = gate();
  const held = gate();
  let count = 0;
  vi.mocked(LspClient.prototype.diagnostics).mockImplementation(async () => {
    if (++count === 2) entered.release();
    await held.promise;
    return [];
  });
  const other = Object.create(f.ctx, { sessionManager: { value: { getSessionId: () => "two" } } });
  try {
    const first = f.execute("diagnostics");
    const second = f.execute("diagnostics", other);
    await entered.promise;
    const stopping = f.emit("session_shutdown");
    held.release();
    await stopping;
    await assert.rejects(first, /aborted/);
    await second;
    assert.equal(close.mock.calls.length, 1);
  } finally {
    held.release();
    await f.dispose();
  }
});

test("reentrant replacement from an old abort listener cannot retire the new scope", async () => {
  const f = harness();
  const close = fakeClients();
  const entered = gate();
  const held = gate();
  let replacement: Promise<unknown> | undefined;
  let starting: Promise<void> | undefined;
  vi.mocked(LspClient.prototype.diagnostics).mockImplementationOnce(async () => {
    entered.release();
    await held.promise;
    return [];
  });
  close.mockImplementationOnce(() => {
    starting = f.emit("session_start");
    replacement = f.execute("diagnostics");
  });
  try {
    const old = f.execute("diagnostics");
    await entered.promise;
    const stopping = f.emit("session_shutdown");
    assert.ok(replacement);
    held.release();
    await stopping;
    await starting;
    await assert.rejects(old, /aborted/);
    await replacement;
    assert.equal(close.mock.calls.length, 1);
    await f.emit("session_shutdown");
  } finally {
    held.release();
    await f.dispose();
  }
});

test("scope retires before abort reentrancy, tracks accepted work, and unlinks caller", async () => {
  const scope = new LspSessionScope();
  const caller = new AbortController();
  const held = gate();
  let reentrant: Promise<unknown> | undefined;
  const task = scope.run(caller.signal, async (signal) => {
    signal.addEventListener("abort", () => {
      reentrant = scope.run(undefined, async () => "late");
      void reentrant.catch(() => {});
    });
    await held.promise;
    return "old";
  });
  void task.catch(() => {});
  const closing = scope.close();
  assert.equal(scope.close(), closing);
  assert.ok(reentrant);
  await assert.rejects(reentrant, /closing/);
  held.release();
  await closing;
  await assert.rejects(task, /aborted/);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  await assert.rejects(
    scope.run(undefined, async () => "late"),
    /closing/,
  );
});

for (const kind of ["diagnostics", "fix"] as const) {
  test(`SDK ${kind}: drain precedes invalidation of real lazy context getters`, async () => {
    const f = harness(kind === "fix" ? "textDocument/codeAction" : "initialize");
    let runner: ExtensionRunner | undefined;
    let task: Promise<unknown> | undefined;
    try {
      const loader = new DefaultResourceLoader({
        cwd: f.root,
        agentDir: f.root,
        settingsManager: SettingsManager.inMemory({}),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [extension],
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        f.root,
        SessionManager.inMemory(f.root),
        {} as ModelRegistry,
      );
      const errors: unknown[] = [];
      runner.onError((error) => {
        errors.push(error);
      });
      await runner.emit({ type: "session_start", reason: "startup" });
      const ctx = runner.createContext();
      const tool = runner.getToolDefinition(`lsp_${kind}`);
      assert.ok(tool);
      task = tool.execute("sdk", { path: f.file, paths: [f.file], write: true }, f.controller.signal, undefined, ctx);
      void task.catch(() => {});
      await f.ready(kind === "fix" ? "textDocument/codeAction" : "initialize");
      await runner.emit({ type: "session_shutdown", reason: "reload" });
      f.exited();
      runner.invalidate();
      assert.throws(() => ctx.ui, /stale/i);
      assert.throws(() => ctx.mode, /stale/i);
      await assert.rejects(task, /aborted|cancelled/);
      assert.deepEqual(errors, []);
    } finally {
      f.controller.abort();
      await task?.catch(() => {});
      await f.dispose();
    }
  }, 10_000);
}

test("shutdown of a replacement also awaits its retiring predecessor", async () => {
  const f = harness();
  fakeClients();
  const entered = gate();
  const held = gate();
  vi.mocked(LspClient.prototype.diagnostics).mockImplementation(async () => {
    entered.release();
    await held.promise;
    return [];
  });
  try {
    const old = f.execute("diagnostics");
    await entered.promise;
    const starting = f.emit("session_start");
    let drained = false;
    const stopping = f.emit("session_shutdown").then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    held.release();
    await Promise.all([starting, stopping]);
    await assert.rejects(old, /aborted/);
    assert.equal(drained, true);
  } finally {
    held.release();
    await f.dispose();
  }
});

for (const kind of ["diagnostics", "fix"] as const) {
  test(`real ${kind}: caller signal aborts session-owned client`, async () => {
    const f = harness("initialize");
    try {
      const task = f.execute(kind);
      await f.ready("initialize");
      f.controller.abort();
      await assert.rejects(task, /aborted|cancelled/);
      f.exited();
      await f.emit("session_shutdown");
      assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
    } finally {
      await f.dispose();
    }
  }, 10_000);
}

for (const uiFailure of ["getter", "setter"] as const) {
  for (const operationFails of [false, true]) {
    test(`status ${uiFailure} failure preserves ${operationFails ? "original error" : "result"} and cleanup`, async () => {
      const f = harness();
      fakeClients();
      const original = new Error("original diagnostics failure");
      if (operationFails) vi.mocked(LspClient.prototype.diagnostics).mockRejectedValueOnce(original);
      const target = Object.create(f.base, {
        ui: {
          get() {
            if (uiFailure === "getter") throw new Error("unavailable UI getter");
            return {
              setStatus() {
                throw new Error("unavailable status setter");
              },
            };
          },
        },
      });
      try {
        const task = f.execute("diagnostics", target);
        if (operationFails) await assert.rejects(task, (error) => error === original);
        else await task;
        assert.equal(vi.mocked(LspClient.prototype.shutdown).mock.calls.length, 1);
      } finally {
        await f.dispose();
      }
    });
  }
}

test("non-TUI mode does not access status UI or bypass resource cleanup", async () => {
  const f = harness();
  fakeClients();
  let accesses = 0;
  const headless = Object.create(f.base, {
    mode: { value: "rpc" },
    ui: {
      get() {
        accesses++;
        throw new Error("no TUI");
      },
    },
  });
  try {
    await f.execute("diagnostics", headless);
    assert.equal(accesses, 0);
    assert.equal(vi.mocked(LspClient.prototype.shutdown).mock.calls.length, 1);
  } finally {
    await f.dispose();
  }
});

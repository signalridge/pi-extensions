import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";
import * as actions from "../src/actions.js";
import { CAPTURE_BYTES_PER_STREAM } from "../src/captured-output.js";
import { executeSnippet } from "../src/snippet-process.js";

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    // A killed orphan can remain a zombie under a container's non-reaping PID 1.
    if (process.platform === "linux") return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixture(produce = false) {
  const cwd = mkdtempSync(path.join(tmpdir(), "snippet 'quoted' space-"));
  const log = path.join(cwd, "pids.txt");
  const worker = path.join(cwd, "worker.cjs");
  const leaf = `const fs = require('node:fs'); process.on('SIGTERM', () => {});
    fs.appendFileSync(${JSON.stringify(log)}, process.pid + '\\n'); setInterval(() => {}, 1000);`;
  writeFileSync(
    worker,
    `const { spawn } = require('node:child_process');
    const fs = require('node:fs'); process.on('SIGTERM', () => {});
    fs.appendFileSync(${JSON.stringify(log)}, process.pid + '\\n');
    spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
    ${
      produce
        ? `
    const block = Buffer.alloc(16384, 'p');
    async function pump() {
      while (true) {
        for (const stream of [process.stdout, process.stderr]) {
          if (!stream.write(block)) await new Promise(resolve => stream.once('drain', resolve));
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    pump();`
        : ""
    }`,
  );
  const pids = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  const script = `${quote(process.execPath)} ${quote(worker)} & wait`;
  return {
    cwd,
    log,
    pids,
    script,
    async ready() {
      await waitFor(() => pids().length === 2, "child/grandchild did not start");
    },
    async gone() {
      await waitFor(() => pids().every((pid) => !alive(pid)), "snippet descendants survived cleanup");
    },
    async cleanup() {
      for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
      await waitFor(() => pids().every((pid) => !alive(pid)), "fixture survived teardown");
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const retirementEvents = [
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_start",
  "session_tree",
  "session_shutdown",
] as const;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const event of retirementEvents) {
  test(`${event} and repeated shutdown await an already-retired run`, async () => {
    const entered = gate();
    const cleanup = gate();
    let signal: AbortSignal | undefined;
    const run = spyOn(actions, "runSnippet").mockImplementation(async (_pi, _ctx, _content, ownership) => {
      signal = ownership.signal;
      entered.resolve();
      await cleanup.promise;
    });
    const handlers = new Map<string, () => Promise<void>>();
    let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    extension({
      on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler),
      registerCommand: (_name: string, definition: { handler: typeof command }) => {
        command = definition.handler;
      },
    } as never);
    const ctx = {
      mode: "rpc",
      hasUI: true,
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => "session",
        getLeafId: () => "leaf",
        getBranch: () => [
          {
            type: "message",
            id: "leaf",
            timestamp: "",
            message: { role: "assistant", content: "```sh\nprintf safe\n```" },
          },
        ],
      },
      ui: { confirm: async () => true, notify: () => assert.fail("retired runs cannot notify") },
    } as unknown as ExtensionCommandContext;
    let pending: Promise<void> | undefined;
    let retiring: Promise<void> | undefined;
    let repeated: Promise<void> | undefined;
    try {
      pending = command("run 1", ctx);
      await entered.promise;
      retiring = handlers.get(event)?.();
      repeated = handlers.get("session_shutdown")?.();
      assert.ok(retiring && repeated);
      assert.equal(signal?.aborted, true);
      let retired = false;
      let repeatedRetired = false;
      void retiring.then(() => {
        retired = true;
      });
      void repeated.then(() => {
        repeatedRetired = true;
      });
      // Drain runnable callbacks, not a duration estimate or an OS PID observation.
      // The owned run cannot settle until this test explicitly releases cleanup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(retired, false, "first retirement must await the owned run");
      assert.equal(repeatedRetired, false, "repeated retirement must await the same owned run");
      assert.equal(run.mock.calls.length, 1);
      cleanup.resolve();
      await Promise.all([pending, retiring, repeated]);
      assert.equal(retired, true);
      assert.equal(repeatedRetired, true);
    } finally {
      cleanup.resolve();
      await Promise.allSettled([pending, retiring, repeated]);
      run.mockRestore();
    }
  });

  test.skipIf(process.platform === "win32")(
    `${event} waits for real TERM-resistant children and suppresses stale output`,
    async () => {
      const tree = fixture();
      const handlers = new Map<string, () => Promise<void>>();
      let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      let confirm!: (value: boolean) => void;
      let retired = false;
      let retiredReads = 0;
      let capturedCwd = tree.cwd;
      const notices: string[] = [];
      let runSettled = false;
      const originalRun = actions.runSnippet;
      const run = spyOn(actions, "runSnippet").mockImplementation((...args) =>
        originalRun(...args).finally(() => {
          runSettled = true;
        }),
      );
      extension({
        on: (name: string, handler: () => Promise<void>) => {
          handlers.set(name, handler);
        },
        registerCommand: (_name: string, definition: { handler: typeof command }) => {
          command = definition.handler;
        },
        exec: () => assert.fail("snippet must own its process tree, not use host exec"),
      } as never);
      const ctx = new Proxy(
        {
          mode: "rpc",
          hasUI: true,
          get cwd() {
            return capturedCwd;
          },
          sessionManager: {
            getSessionId: () => "session",
            getLeafId: () => "leaf",
            getBranch: () => [
              {
                type: "message",
                id: "leaf",
                timestamp: "",
                message: { role: "assistant", content: `\`\`\`sh\n${tree.script}\n\`\`\`` },
              },
            ],
          },
          ui: {
            confirm: () =>
              new Promise<boolean>((resolve) => {
                confirm = resolve;
              }),
            notify: (notice: string) => notices.push(notice),
          },
        },
        {
          get(target, property, receiver) {
            if (retired) {
              retiredReads++;
              throw new Error("retired context accessed");
            }
            return Reflect.get(target, property, receiver);
          },
        },
      ) as unknown as ExtensionCommandContext;
      let pending: Promise<void> | undefined;
      try {
        pending = command("run 1", ctx);
        assert.equal(existsSync(tree.log), false, "nothing starts before confirmation");
        capturedCwd = path.join(tree.cwd, "does-not-exist");
        confirm(true);
        await tree.ready();
        assert.ok(tree.pids().every(alive));
        retired = true;
        const before = Date.now();
        const retiring = handlers.get(event)?.();
        const repeated = handlers.get("session_shutdown")?.();
        assert.ok(retiring && repeated);
        await Promise.all([
          retiring.then(() => {
            assert.equal(runSettled, true, "first retirement returned before its real owned run settled");
          }),
          repeated.then(() => {
            assert.equal(runSettled, true, "repeated retirement returned before its real owned run settled");
          }),
        ]);
        assert.ok(Date.now() - before < 3000, "retirement cleanup must be bounded");
        // Supervisor exit/pipe closure does not synchronously finish descendant
        // termination. Observe eventual exit before teardown can signal anything.
        // The gated test above independently proves the repeated-retirement barrier.
        await tree.gone();
        await pending;
        assert.equal(retiredReads, 0);
        assert.deepEqual(notices, []);
      } finally {
        try {
          await handlers.get("session_shutdown")?.();
          await pending;
        } finally {
          try {
            await tree.cleanup();
          } finally {
            run.mockRestore();
          }
        }
      }
    },
    10_000,
  );
}

test.skipIf(process.platform === "win32")(
  "normal shell exit cleans resistant background descendants while the group leader stays pinned",
  async () => {
    const tree = fixture();
    const controller = new AbortController();
    const ownership = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    let pending: ReturnType<typeof executeSnippet> | undefined;
    try {
      // Do not wait for the background job. Ensure both processes have installed TERM handlers.
      const script = `${quote(process.execPath)} ${quote(path.join(tree.cwd, "worker.cjs"))} &
      while [ ! -f ${quote(tree.log)} ] || [ "$(wc -l < ${quote(tree.log)})" -lt 2 ]; do sleep 0.01; done
      printf 'normal output'; printf 'error output' >&2; exit 7`;
      pending = executeSnippet("bash", ["-lc", script], tree.cwd, ownership);
      const result = await pending;
      assert.deepEqual(result, { stdout: "normal output", stderr: "error output", code: 7, killed: false });
      await tree.gone();
      assert.ok(sentinel.pid && alive(sentinel.pid), "cleanup must not signal an unrelated process in Pi's group");
    } finally {
      controller.abort();
      sentinel.kill("SIGKILL");
      await pending;
      await tree.cleanup();
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "plain background sleep is cancelled as a tree, not only its waiting shell",
  async () => {
    const tree = fixture();
    const controller = new AbortController();
    let pending: ReturnType<typeof executeSnippet> | undefined;
    try {
      pending = executeSnippet("bash", ["-lc", `sleep 600 & echo $! > ${quote(tree.log)}; wait`], tree.cwd, {
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
      });
      await waitFor(() => tree.pids().length === 1, "sleep did not start");
      assert.ok(tree.pids().every(alive));
      controller.abort();
      assert.equal((await pending).killed, true);
      await tree.gone();
    } finally {
      controller.abort();
      await pending;
      await tree.cleanup();
    }
  },
  10_000,
);

test.skipIf(process.platform === "win32")(
  "captured cwd, unicode output and a nonzero shell exit survive cleanup",
  async () => {
    const tree = fixture();
    const controller = new AbortController();
    try {
      const result = await executeSnippet("bash", ["-lc", "pwd; printf 'α🙂'; printf 'stderr' >&2; exit 9"], tree.cwd, {
        signal: controller.signal,
        isCurrent: () => true,
      });
      assert.equal(result.stdout, `${realpathSync(tree.cwd)}\nα🙂`);
      assert.equal(result.stderr, "stderr");
      assert.equal(result.code, 9);
      assert.equal(result.killed, false);
    } finally {
      await tree.cleanup();
    }
  },
);

test("retired ownership never spawns a snippet", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeSnippet("nonexistent-shell", [], "nonexistent-cwd", {
    signal: controller.signal,
    isCurrent: () => false,
  });
  assert.equal(result.killed, true);
});

test("immediate cancellation and spawn failure settle without waiting forever", async () => {
  const controller = new AbortController();
  const pending = executeSnippet(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), {
    signal: controller.signal,
    isCurrent: () => true,
  });
  controller.abort();
  assert.equal((await pending).killed, true);
  const failure = await executeSnippet("bash", [], path.join(tmpdir(), "missing-code-actions-cwd", "absent"), {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /Could not start snippet supervisor/);
  assert.equal(failure.code, 1);
  assert.equal(failure.killed, false);
}, 5000);

// Runtime identity injection qualifies launch selection, not a physical standalone Pi build.
test("compiled-Bun launch seam uses Node on PATH rather than the embedded Pi executable", async () => {
  const runtime = {
    execPath: path.join(tmpdir(), "nonexistent-embedded-pi"),
    versions: { ...process.versions, bun: "test" },
  };
  const result = await executeSnippet(
    "node",
    ["-e", "process.stdout.write('node helper')"],
    process.cwd(),
    {
      signal: new AbortController().signal,
      isCurrent: () => true,
    },
    runtime,
  );
  assert.deepEqual(result, { stdout: "node helper", stderr: "", code: 0, killed: false });
});

test("Bun launch without Node on PATH fails with an actionable prerequisite", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "snippet-no-node-"));
  const previousPath = process.env.PATH;
  let pending: ReturnType<typeof executeSnippet>;
  try {
    process.env.PATH = directory;
    pending = executeSnippet(
      "unused-shell",
      [],
      directory,
      {
        signal: new AbortController().signal,
        isCurrent: () => true,
      },
      { execPath: "embedded-pi", versions: { ...process.versions, bun: "test" } },
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  try {
    const result = await pending;
    assert.equal(result.code, 1);
    assert.equal(result.killed, false);
    assert.match(result.stderr, /requires a Node.js executable \(node\) on PATH/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "inherited inspect-brk stalls the real Node helper: startup expires, owned process dies, next run recovers",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "snippet-debugger-"));
    const log = path.join(directory, "pid.txt");
    const launcher = path.join(directory, "node-launcher");
    const controller = new AbortController();
    const ownership = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
    const previousOptions = process.env.NODE_OPTIONS;
    let pending: ReturnType<typeof executeSnippet> | undefined;
    let pid: number | undefined;
    try {
      // exec retains the logged PID and the private detached group, while Node
      // really stalls before evaluating the supervisor (not a mocked readiness failure).
      writeFileSync(launcher, `#!/bin/sh\nprintf '%s' "$$" > ${quote(log)}\nexec node "$@"\n`, { mode: 0o700 });
      const started = Date.now();
      try {
        process.env.NODE_OPTIONS = "--inspect-brk=0";
        pending = executeSnippet("bash", ["-lc", "printf should-not-run"], directory, ownership, {
          execPath: launcher,
          versions: { ...process.versions, bun: undefined },
        });
      } finally {
        if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousOptions;
      }
      await waitFor(() => existsSync(log) && Number(readFileSync(log, "utf8")) > 1, "debugger helper did not start");
      pid = Number(readFileSync(log, "utf8"));
      assert.ok(alive(pid), "helper must be alive before its startup deadline");
      const result = await pending;
      assert.equal(result.code, 1);
      assert.equal(result.killed, false, "startup failure is not user cancellation");
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Debugger listening/);
      assert.match(result.stderr, /did not become ready within 5000 ms/);
      assert.ok(Date.now() - started >= 5000);
      assert.ok(Date.now() - started < 8000, "startup failure and owned cleanup must be bounded");
      await waitFor(() => !alive(pid as number), "debugger-stalled helper survived cleanup");
      const recovered = await executeSnippet("bash", ["-lc", "printf recovered"], directory, ownership);
      assert.deepEqual(recovered, { stdout: "recovered", stderr: "", code: 0, killed: false });
    } finally {
      controller.abort();
      if (pid === undefined && existsSync(log)) pid = Number(readFileSync(log, "utf8"));
      if (pid !== undefined && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
      await pending;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  12_000,
);

for (const ready of [false, true]) {
  test.skipIf(process.platform === "win32")(
    `IPC disconnection ${ready ? "after" : "before"} readiness fails and cleans its live supervisor`,
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "snippet-disconnect-"));
      const log = path.join(directory, "pid.txt");
      const launcher = path.join(directory, "node-launcher");
      const controller = new AbortController();
      let pending: ReturnType<typeof executeSnippet> | undefined;
      let pid: number | undefined;
      try {
        const source = `require('node:fs').writeFileSync(${JSON.stringify(log)}, String(process.pid));
          process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
          ${ready ? "process.send('ready');" : ""} process.disconnect();`;
        // Inject a defective eval runtime that drops IPC while remaining alive.
        writeFileSync(launcher, `#!/bin/sh\nexec node -e ${quote(source)}\n`, { mode: 0o700 });
        const started = Date.now();
        pending = executeSnippet(
          "unused-shell",
          [],
          directory,
          {
            signal: controller.signal,
            isCurrent: () => !controller.signal.aborted,
          },
          { execPath: launcher, versions: { ...process.versions, bun: undefined } },
        );
        const result = await pending;
        pid = Number(readFileSync(log, "utf8"));
        assert.equal(result.code, 1);
        assert.equal(result.killed, false);
        assert.match(result.stderr, /IPC disconnected before completion/);
        assert.ok(Date.now() - started < 3000, "disconnect must not wait for the startup deadline");
        await waitFor(() => !alive(pid as number), "disconnected helper survived cleanup");
      } finally {
        controller.abort();
        if (pid === undefined && existsSync(log)) pid = Number(readFileSync(log, "utf8"));
        if (pid !== undefined && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
        await pending;
        rmSync(directory, { recursive: true, force: true });
      }
    },
    6000,
  );
}

test("ready snippets can exceed the startup deadline and inherit Node security options and environment", async () => {
  const previousOptions = process.env.NODE_OPTIONS;
  const previousValue = process.env.CODE_ACTIONS_TEST_ENV;
  let pending: ReturnType<typeof executeSnippet>;
  try {
    process.env.NODE_OPTIONS = "--disable-proto=throw";
    process.env.CODE_ACTIONS_TEST_ENV = "preserved";
    pending = executeSnippet(
      "node",
      [
        "-e",
        `setTimeout(() => {
      try { ({}).__proto__; } catch (error) {
        process.stdout.write(process.env.NODE_OPTIONS + ':' + process.env.CODE_ACTIONS_TEST_ENV + ':' + error.code);
      }
    }, 5200);`,
      ],
      process.cwd(),
      {
        signal: new AbortController().signal,
        isCurrent: () => true,
      },
    );
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
    if (previousValue === undefined) delete process.env.CODE_ACTIONS_TEST_ENV;
    else process.env.CODE_ACTIONS_TEST_ENV = previousValue;
  }
  const result = await pending;
  assert.deepEqual(result, {
    stdout: "--disable-proto=throw:preserved:ERR_PROTO_ACCESS",
    stderr: "",
    code: 0,
    killed: false,
  });
}, 10_000);

test("large real stdout/stderr long lines are independently byte bounded, decoded and continuously drained", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "snippet-large-output-"));
  const worker = path.join(cwd, "large.cjs");
  // Split multibyte characters across writes on both streams, then end the
  // capture prefix partway through another character. Never buffer a whole line.
  writeFileSync(
    worker,
    `
    const { once } = require('node:events');
    const fs = require('node:fs');
    async function write(stream, bytes) {
      if (!stream.write(bytes)) await once(stream, 'drain');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    (async () => {
      const prefix = Buffer.from('α🙂');
      for (const byte of prefix) {
        await write(process.stdout, Buffer.from([byte]));
        await write(process.stderr, Buffer.from([byte]));
      }
      const remaining = ${CAPTURE_BYTES_PER_STREAM} - prefix.length - 1;
      await write(process.stdout, Buffer.alloc(remaining, 'o'));
      await write(process.stderr, Buffer.alloc(remaining, 'e'));
      await write(process.stdout, Buffer.from('🙂'));
      await write(process.stderr, Buffer.from('α'));
      const block = Buffer.alloc(65536, 'x');
      for (let i = 0; i < 64; i++) {
        await write(process.stdout, block);
        await write(process.stderr, block);
      }
      fs.writeFileSync('drained.flag', 'done');
    })();
  `,
  );
  try {
    const result = await executeSnippet("node", [worker], cwd, {
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    const prefixBytes = Buffer.byteLength("α🙂");
    for (const [stream, fill] of [
      ["stdout", "o"],
      ["stderr", "e"],
    ] as const) {
      const expected = `α🙂${fill.repeat(CAPTURE_BYTES_PER_STREAM - prefixBytes - 1)}`;
      assert.equal(
        result[stream],
        `${expected}\n[${stream} truncated: output beyond the 64 KiB capture limit was discarded.]\n`,
      );
      assert.ok(Buffer.byteLength(result[stream]) < CAPTURE_BYTES_PER_STREAM + 100);
      assert.ok(!result[stream].includes("�"), "overflow must not flush a cut Unicode character");
    }
    assert.ok(existsSync(path.join(cwd, "drained.flag")), "overflow must not stop either pipe draining");
    assert.equal(result.code, 0);
    assert.equal(result.killed, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 10_000);

test.skipIf(process.platform === "win32")(
  "cancelling an infinite two-stream producer cleans its resistant descendant, not unrelated children",
  async () => {
    const tree = fixture(true);
    const controller = new AbortController();
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    let pending: ReturnType<typeof executeSnippet> | undefined;
    try {
      pending = executeSnippet("bash", ["-lc", tree.script], tree.cwd, {
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
      });
      await tree.ready();
      // Let both pipes exceed the capture bound before cancelling the producer.
      await new Promise((resolve) => setTimeout(resolve, 250));
      controller.abort();
      const result = await pending;
      assert.equal(result.killed, true);
      assert.match(result.stdout, /stdout truncated/);
      assert.match(result.stderr, /stderr truncated/);
      assert.ok(Buffer.byteLength(result.stdout) < CAPTURE_BYTES_PER_STREAM + 100);
      assert.ok(Buffer.byteLength(result.stderr) < CAPTURE_BYTES_PER_STREAM + 100);
      await tree.gone();
      assert.ok(sentinel.pid && alive(sentinel.pid), "owned cleanup must not signal an unrelated child");
    } finally {
      controller.abort();
      await pending;
      sentinel.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (sentinel.exitCode !== null || sentinel.signalCode !== null) resolve();
        else sentinel.once("close", () => resolve());
      });
      await tree.cleanup();
    }
  },
  10_000,
);

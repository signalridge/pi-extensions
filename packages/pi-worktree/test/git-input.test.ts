import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, vi } from "vitest";
import { GitWorktreeError, worktreeInventory } from "../src/git.ts";
import { GitInputError, runGitInput } from "../src/git-input.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const boundary of [
  "abort",
  "timeout",
  "unconfirmed-abort",
  "unconfirmed-timeout",
  "inventory-abort",
  "inventory-timeout",
  "inventory-unconfirmed-abort",
  "inventory-unconfirmed-timeout",
  "unconfirmed-false-kill",
  "inventory-unconfirmed-thrown-kill",
] as const) {
  test.skipIf(process.platform === "win32")(
    `stdin Git ${boundary} has bounded TERM/KILL ownership and settlement`,
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "worktree-fake-git-"));
      writeFileSync(
        join(cwd, "git"),
        `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); process.stdin.resume(); process.stdout.write('ready\\n'); process.stderr.write('retained diagnostics\\n'); setInterval(() => {}, 1000);\n`,
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", cwd);
      const spawn = vi.mocked(childProcess.spawn);
      spawn.mockClear();
      const controller = new AbortController();
      const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
      let child: childProcess.ChildProcessWithoutNullStreams | undefined;
      let nativeKill: ((signal?: NodeJS.Signals | number) => boolean) | undefined;
      let kill: ReturnType<typeof vi.spyOn> | undefined;
      let failed: Error | undefined;
      const deletions = vi.spyOn(Map.prototype, "delete");
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const inventory = boundary.startsWith("inventory");
        const pi = {
          exec: async (_command: string, args: string[]) => ({
            stdout: args[0] === "ls-files" ? "S exact\\path \0" : args[0] === "config" ? "true\n" : "",
            stderr: "",
            code: 0,
            killed: false,
          }),
        };
        const promise = inventory
          ? worktreeInventory(pi, cwd, controller.signal)
          : runGitInput(["sparse-checkout", "check-rules", "-z"], cwd, "exact\\path \0", controller.signal);
        // Attach rejection handling before advancing any deadline.
        const observed = promise.catch((error: Error) => {
          failed = error;
          return undefined;
        });
        await flush(); // inventory reaches stdin through read-only mock exec calls
        child = spawn.mock.results[0]?.value as childProcess.ChildProcessWithoutNullStreams;
        assert.ok(child);
        const closed = new Promise<void>((resolve) => child?.once("close", () => resolve()));
        await Promise.all([
          new Promise<void>((resolve) => child?.stdout.once("data", () => resolve())),
          new Promise<void>((resolve) => child?.stderr.once("data", () => resolve())),
        ]);
        nativeKill = child.kill.bind(child);
        kill = vi.spyOn(child, "kill");
        const unconfirmed = boundary.includes("unconfirmed");
        if (unconfirmed)
          kill.mockImplementation(() => {
            if (boundary.endsWith("false-kill")) return false;
            if (boundary.endsWith("thrown-kill")) throw new Error("signal permission denied");
            return true;
          }); // no actual signal; confirmation must come from the owned process
        if (boundary.endsWith("timeout")) await vi.advanceTimersByTimeAsync(15_000);
        else controller.abort();
        assert.deepEqual(
          kill.mock.calls.map(([signal]) => signal),
          ["SIGTERM"],
        );
        await vi.advanceTimersByTimeAsync(250);
        assert.deepEqual(
          kill.mock.calls.map(([signal]) => signal),
          ["SIGTERM", "SIGKILL"],
        );
        if (unconfirmed) {
          await vi.advanceTimersByTimeAsync(1_000);
          assert.equal(await observed, undefined);
          assert.match(failed?.message ?? "", /termination could not be confirmed/);
          if (inventory)
            assert.ok(failed instanceof GitWorktreeError, "inventory propagates actionable process failure");
          assert.match(failed?.message ?? "", boundary.endsWith("timeout") ? /15000ms timeout/ : /cancellation/);
          assert.equal(vi.getTimerCount(), 0);
          assert.equal(child.listenerCount("error"), 0);
          // Retained handle owns just its terminal observers, not output/timers.
          assert.equal(child.listenerCount("close"), 2);
          assert.equal(child.listenerCount("exit"), 1);
          const processFailure = inventory && failed instanceof GitWorktreeError ? failed.cause : failed;
          assert.ok(processFailure instanceof GitInputError);
          assert.equal(processFailure.stdout, "ready\n");
          assert.equal(processFailure.stderr, "retained diagnostics\n");
          assert.equal(processFailure.terminationConfirmed, false);
          assert.equal("code" in processFailure, false, "no fabricated exit result");
          assert.deepEqual(
            processFailure.signals.map(({ signal, accepted }) => ({ signal, accepted })),
            [
              { signal: "SIGTERM", accepted: !boundary.endsWith("false-kill") && !boundary.endsWith("thrown-kill") },
              { signal: "SIGKILL", accepted: !boundary.endsWith("false-kill") && !boundary.endsWith("thrown-kill") },
            ],
          );
          if (boundary.endsWith("thrown-kill")) {
            assert.match(
              processFailure.cause instanceof Error ? processFailure.cause.message : "",
              /permission denied/,
            );
            assert.ok(processFailure.signals.every(({ error }) => error?.message === "signal permission denied"));
          }
          if (inventory && failed instanceof GitWorktreeError) {
            assert.equal(failed.stdout, processFailure.stdout);
            assert.equal(failed.stderr, processFailure.stderr);
          }
          assert.equal(child.stdout.listenerCount("data"), 0);
          assert.equal(removeAbort.mock.calls.filter(([name]) => name === "abort").length, 1);
          await assert.rejects(
            runGitInput(["sparse-checkout", "check-rules", "-z"], cwd, "", undefined),
            /Previous Git termination is unconfirmed/,
          );
          assert.equal(spawn.mock.calls.length, 1, "no replacement until actual termination");
          assert.equal(kill.mock.calls.length, 2, "no historical PID retry or replacement kill");
          const key = JSON.stringify([cwd, ["sparse-checkout", "check-rules", "-z"]]);
          const deletedBeforeExit = deletions.mock.calls.filter(([value]) => value === key).length;
          nativeKill("SIGKILL");
          await closed;
          assert.equal(
            deletions.mock.calls.filter(([value]) => value === key).length,
            deletedBeforeExit + 1,
            "late actual exit releases map lease without another invocation",
          );
          assert.equal(child.listenerCount("exit"), 0);
          assert.equal(child.listenerCount("close"), 0);
        } else {
          await closed;
          const result = await observed;
          if (inventory) {
            assert.equal(result, undefined);
            assert.ok(failed instanceof GitWorktreeError);
            assert.match(failed.message, /cancelled|timed out/u);
          } else {
            assert.equal(result && "killed" in result ? result.killed : undefined, true);
            assert.equal(result && "truncated" in result ? result.truncated : undefined, false);
            assert.equal(failed, undefined);
          }
          assert.equal(vi.getTimerCount(), 0);
          assert.equal(removeAbort.mock.calls.filter(([name]) => name === "abort").length, 1);
          assert.equal(child.listenerCount("close"), 0);
        }
        await flush();
        assert.notEqual(child.signalCode, null, "actual owned fixture exited");
      } finally {
        if (child?.exitCode === null && child.signalCode === null) nativeKill?.("SIGKILL");
        kill?.mockRestore();
        spawn.mockRestore();
        removeAbort.mockRestore();
        deletions.mockRestore();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
}

for (const failure of ["false", "EPERM"] as const) {
  test.skipIf(process.platform === "win32")(
    `concurrent unconfirmed Git retains every handle (${failure})`,
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "worktree-multi-git-"));
      writeFileSync(
        join(cwd, "git"),
        `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); process.stdin.resume(); process.stdout.write('ready\\n'); process.stderr.write('diagnostics\\n'); setInterval(() => {}, 1000);\n`,
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", cwd);
      const spawn = vi.mocked(childProcess.spawn);
      spawn.mockClear();
      const children: childProcess.ChildProcessWithoutNullStreams[] = [];
      const kills: Array<ReturnType<typeof vi.spyOn>> = [];
      const nativeKills: Array<(signal?: NodeJS.Signals | number) => boolean> = [];
      const closed: Promise<void>[] = [];
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const controllers = [new AbortController(), new AbortController()];
        const args = ["sparse-checkout", "check-rules", "-z"];
        // Both equivalent invocations are active before either fails confirmation.
        const pending = controllers.map((controller) =>
          runGitInput(args, cwd, "exact\\path \0", controller.signal).catch((error: unknown) => error),
        );
        const ready: Promise<void>[] = [];
        for (const result of spawn.mock.results) {
          const child = result.value as childProcess.ChildProcessWithoutNullStreams;
          children.push(child);
          closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
          ready.push(
            new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
            new Promise<void>((resolve) => child.stderr.once("data", () => resolve())),
          );
          nativeKills.push(child.kill.bind(child));
          kills.push(
            vi.spyOn(child, "kill").mockImplementation(() => {
              if (failure === "EPERM") throw Object.assign(new Error("permission denied"), { code: "EPERM" });
              return false;
            }),
          );
        }
        assert.equal(children.length, 2);
        await Promise.all(ready);
        for (const controller of controllers) controller.abort();
        await vi.advanceTimersByTimeAsync(1_250);
        for (const error of await Promise.all(pending)) {
          assert.ok(error instanceof GitInputError);
          assert.equal(error.terminationConfirmed, false);
          assert.equal(error.stdout, "ready\n");
          assert.equal(error.stderr, "diagnostics\n");
          assert.deepEqual(
            error.signals.map(({ signal, accepted }) => [signal, accepted]),
            [
              ["SIGTERM", false],
              ["SIGKILL", false],
            ],
          );
          if (failure === "EPERM") assert.equal((error.cause as NodeJS.ErrnoException).code, "EPERM");
        }
        assert.equal(vi.getTimerCount(), 0);
        // B closes first. A's failed live handle must still block equivalent C.
        nativeKills[1]("SIGKILL");
        await closed[1];
        assert.equal(children[0].exitCode, null);
        assert.equal(children[0].signalCode, null);
        const blocked = runGitInput(args, cwd, "");
        void blocked.catch(() => {});
        // Keep an erroneously admitted fixture owned for failure-path cleanup.
        if (spawn.mock.results.length > 2) {
          const unexpected = spawn.mock.results[2].value as childProcess.ChildProcessWithoutNullStreams;
          children.push(unexpected);
          nativeKills.push(unexpected.kill.bind(unexpected));
          closed.push(new Promise<void>((resolve) => unexpected.once("close", () => resolve())));
        }
        assert.equal(spawn.mock.calls.length, 2, "B's exit must not release A's live lease");
        await assert.rejects(blocked, /Previous Git termination is unconfirmed/);
        nativeKills[0]("SIGKILL");
        await closed[0];
        // A's actual confirmation releases only A; now a new C may be admitted.
        const controller = new AbortController();
        const admitted = runGitInput(args, cwd, "", controller.signal);
        const child = spawn.mock.results[2].value as childProcess.ChildProcessWithoutNullStreams;
        children.push(child);
        nativeKills.push(child.kill.bind(child));
        const closing = new Promise<void>((resolve) => child.once("close", () => resolve()));
        closed.push(closing);
        controller.abort();
        await closing;
        assert.equal((await admitted).killed, true);
        assert.equal(spawn.mock.calls.length, 3);
        assert.ok(
          kills.every((kill) => kill.mock.calls.length === 2),
          "no signaling historical PID or replacement",
        );
        assert.equal(vi.getTimerCount(), 0);
      } finally {
        for (const [index, child] of children.entries())
          if (child.exitCode === null && child.signalCode === null) nativeKills[index]?.("SIGKILL");
        await Promise.all(closed);
        for (const kill of kills) kill.mockRestore();
        spawn.mockRestore();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "real stdin Git overflow drains and confirms the owned child's exit",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worktree-overflow-git-"));
    writeFileSync(
      join(cwd, "git"),
      `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); process.stdin.resume(); process.stdout.write('12345'); process.stderr.write('67890'); setInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", cwd);
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    let child: childProcess.ChildProcessWithoutNullStreams | undefined;
    try {
      const pending = runGitInput(["overflow"], cwd, "", undefined, 15_000, 8);
      child = spawn.mock.results[0].value as childProcess.ChildProcessWithoutNullStreams;
      const kill = vi.spyOn(child, "kill");
      const result = await pending;
      assert.equal(result.truncated, true);
      assert.equal(result.killed, true);
      assert.notEqual(result.code, 0);
      assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 8);
      assert.deepEqual(kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
      assert.notEqual(child.signalCode, null, "actual exit is confirmed before settlement");
      assert.equal(child.listenerCount("close"), 0);
      assert.equal(child.stdout.listenerCount("data"), 0);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      spawn.mockRestore();
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

function controlledChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((_signal: NodeJS.Signals) => true),
  });
  vi.mocked(childProcess.spawn).mockReturnValue(child as unknown as childProcess.ChildProcessWithoutNullStreams);
  return child;
}

for (const boundary of ["abort", "timeout", "overflow"] as const) {
  test(`stdin ${boundary} waits for delayed close and distinguishes truncation`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = controlledChild();
    const controller = new AbortController();
    let settled = false;
    const pending = runGitInput(["test", boundary], "/repo", "", controller.signal, 15_000, 8).then((result) => {
      settled = true;
      return result;
    });
    // Separate writes to the two pipes are each below the cap but combined overflow.
    child.stdout.write(Buffer.from("12345"));
    child.stderr.write(Buffer.from(boundary === "overflow" ? "67890" : "67"));
    if (boundary === "abort") controller.abort();
    if (boundary === "timeout") await vi.advanceTimersByTimeAsync(15_000);
    assert.equal(settled, false);
    assert.deepEqual(child.kill.mock.calls, [["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(250);
    assert.deepEqual(child.kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
    assert.equal(settled, false, "signal acceptance is not exit confirmation");
    // Continue draining after overflow; these bytes must not accumulate.
    if (boundary === "overflow") child.stdout.write(Buffer.alloc(1024, 120));
    child.exitCode = 0;
    child.emit("exit", 0, null);
    assert.equal(settled, false, "wait for output drain/close, not just exit");
    child.emit("close", 0, null);
    const result = await pending;
    assert.equal(result.truncated, boundary === "overflow");
    assert.equal(result.killed, true);
    assert.equal(result.stdout, "12345");
    assert.equal(result.stderr, boundary === "overflow" ? "678" : "67");
    assert.equal(result.code, boundary === "overflow" ? 1 : 0);
    assert.equal(vi.getTimerCount(), 0);
  });
}

for (const maxBuffer of [0, 1, 2, 3, 4, 5, 6, 7]) {
  test(`stdin fragmented UTF-8 is byte bounded at ${maxBuffer} bytes`, async () => {
    const child = controlledChild();
    const pending = runGitInput(["utf8", String(maxBuffer)], "/repo", "", undefined, 15_000, maxBuffer);
    const encoded = Buffer.from("a€b"); // 5 bytes, fragmented inside the three-byte code point.
    child.stdout.write(encoded.subarray(0, 2));
    child.stdout.write(encoded.subarray(2, 3));
    child.stdout.write(encoded.subarray(3));
    child.stderr.write(Buffer.from("é"));
    child.exitCode = 0;
    child.emit("close", 0, null);
    const result = await pending;
    assert.equal(result.stdout, maxBuffer === 0 ? "" : maxBuffer < 4 ? "a" : maxBuffer === 4 ? "a€" : "a€b");
    assert.equal(result.stderr, maxBuffer === 7 ? "é" : "");
    assert.equal(result.truncated, maxBuffer < 7);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= maxBuffer);
    assert.doesNotMatch(result.stdout + result.stderr, /�/u);
    assert.equal(result.code, maxBuffer < 7 ? 1 : 0);
  });
}

test("unconfirmed overflow retains truthful diagnostics and releases only on actual exit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const child = controlledChild();
  const args = ["unconfirmed-overflow"];
  const pending = runGitInput(args, "/repo", "", undefined, 15_000, 5).catch((error: unknown) => error);
  child.stdout.write(Buffer.from("123"));
  child.stderr.write(Buffer.from("456"));
  await vi.advanceTimersByTimeAsync(1250);
  const error = await pending;
  assert.ok(error instanceof GitInputError);
  assert.equal(error.reason, "output overflow (5 bytes)");
  assert.equal(error.truncated, true);
  assert.equal(error.terminationConfirmed, false);
  assert.equal(error.stdout, "123");
  assert.equal(error.stderr, "45");
  assert.doesNotMatch(error.message, /timeout|cancellation/u);
  await assert.rejects(runGitInput(args, "/repo", ""), /Previous Git termination is unconfirmed/u);
  assert.equal(child.kill.mock.calls.length, 2);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  const replacement = controlledChild();
  const admitted = runGitInput(args, "/repo", "");
  replacement.exitCode = 0;
  replacement.emit("close", 0, null);
  assert.equal((await admitted).truncated, false);
  assert.equal(vi.getTimerCount(), 0);
});

test("already cancelled stdin Git never spawns", async () => {
  const spawn = vi.mocked(childProcess.spawn);
  spawn.mockClear();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runGitInput([], ".", "", controller.signal);
    assert.equal(result.killed, true);
    assert.equal(result.truncated, false);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    spawn.mockRestore();
  }
});

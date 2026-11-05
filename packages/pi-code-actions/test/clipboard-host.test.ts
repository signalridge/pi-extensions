import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copySnippet } from "../src/actions.js";
import { fakeClipboard, nativePidExists } from "./clipboard-host.js";

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function gone(fixture: ReturnType<typeof fakeClipboard>) {
  const receipts = fixture.receipts();
  assert.ok(receipts.length > 0, "must observe a real native PID, not just an action promise");
  for (const { pid, started, completed } of receipts) {
    assert.equal(nativePidExists(pid), false, `native child ${pid} was not reaped`);
    assert.equal(nativePidExists(-pid), false, `detached fixture group ${pid} survived`);
    assert.ok(started && completed, `worker ${pid} did not acknowledge completion before proof removal`);
  }
  assert.equal(existsSync(fixture.directory), false);
}

const runtimes = [
  ["Bun", process.execPath],
  ["Node", execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim()],
] as const;

for (const [name, runtime] of runtimes) {
  for (const retireDirectory of [false, true]) {
    test.skipIf(process.platform === "win32")(
      `${name}: all five utility paths and Linux argv flags leave zero PIDs/groups after ${retireDirectory ? "directory retirement" : "disposal"}`,
      async () => {
        const fixture = fakeClipboard("stall", runtime);
        // Explicit native invocations cover every SDK candidate regardless of
        // platform captured at SDK import (including macOS's no-argv pbcopy).
        const invocations = [
          ["pbcopy", []],
          ["wl-copy", []],
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
          ["termux-clipboard-set", []],
        ] as const;
        const children = invocations.map(([utility, args]) => {
          const child = spawn(path.join(fixture.directory, utility), [...args], {
            cwd: "/",
            detached: true,
            stdio: ["pipe", "ignore", "ignore"],
          });
          const closed = new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
          void closed.catch(() => {});
          child.stdin.on("error", () => {});
          child.stdin.end(`private ${utility}`);
          return { child, closed, utility, args };
        });
        try {
          await waitFor(
            () => Object.keys(fixture.received()).length === 5,
            "not all native utility scripts received stdin",
          );
          const receipts = fixture.receipts();
          assert.equal(receipts.length, 5, "native inventory must match utilities even with argv flags");
          for (const { child, utility, args } of children) {
            assert.ok(child.pid && nativePidExists(child.pid));
            assert.ok(receipts.some(({ pid }) => pid === child.pid));
            assert.deepEqual(
              JSON.parse(readFileSync(path.join(fixture.directory, `worker-${child.pid}.started`), "utf8")),
              { pid: child.pid, utility, args },
              "launcher must preserve the SDK utility's exact argv",
            );
          }
          if (retireDirectory) rmSync(fixture.directory, { recursive: true, force: true });
          await fixture.dispose();
          assert.deepEqual(await Promise.all(children.map(({ closed }) => closed)), [0, 0, 0, 0, 0]);
          if (!retireDirectory) gone(fixture);
          for (const { child } of children) {
            assert.ok(child.pid);
            assert.equal(nativePidExists(child.pid), false);
            assert.equal(nativePidExists(-child.pid), false);
          }
          assert.equal(existsSync(fixture.directory), false);
        } finally {
          await fixture.dispose();
          await Promise.all(children.map(({ closed }) => closed));
        }
      },
    );
  }

  test.skipIf(process.platform === "win32")(
    `${name}: disposal drains a real SDK writer before it observes release`,
    async () => {
      const fixture = fakeClipboard("stall", runtime);
      const before = process.env.PATH;
      let completed = false;
      const writer = fixture.write("stalled native writer").then(() => {
        completed = true;
      });
      try {
        await waitFor(() => Object.keys(fixture.received()).length === 1, "native utility did not receive stdin");
        assert.equal(completed, false);
        assert.ok(fixture.receipts().every(({ pid }) => nativePidExists(pid)));
        // Real long-running native worker, not a deferred JS writer stub.
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(completed, false);
        const first = fixture.dispose();
        assert.equal(fixture.dispose(), first, "concurrent teardown shares a drain barrier");
        assert.equal(existsSync(fixture.directory), true, "release proof must outlive pending native exit");
        await first;
        await writer;
        gone(fixture);
        await fixture.restore();
        await fixture.dispose();
        fixture.release();
        gone(fixture);
        assert.notEqual(process.env.PATH, before, "PATH must be restored");
        await assert.rejects(fixture.write("retired"), /fixture is retired/);
      } finally {
        await fixture.dispose();
        await writer;
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `${name}: the public SDK's unchanged timeout reaps a long-running native worker`,
    async () => {
      const fixture = fakeClipboard("stall", runtime);
      const before = Date.now();
      const rejected = assert.rejects(fixture.write("wait for the real SDK timeout"), /Clipboard unavailable/);
      try {
        await waitFor(() => Object.keys(fixture.received()).length === 1, "SDK utility did not start");
        assert.ok(fixture.receipts().every(({ pid }) => nativePidExists(pid)));
        await rejected;
        assert.ok(Date.now() - before >= 5000, "must exercise Pi's real 5000 ms clipboard timeout");
        await fixture.dispose();
        const receipts = fixture.receipts();
        assert.ok(receipts.length > 0);
        for (const { pid, started, completed } of receipts) {
          assert.equal(nativePidExists(pid), false, "SDK must reap its timed-out direct child");
          assert.equal(nativePidExists(-pid), false, "no shell/sleep descendants may survive SDK timeout");
          assert.equal(started, true);
          assert.equal(completed, false, "SIGKILL cannot run a completion handler");
        }
        assert.equal(existsSync(fixture.directory), false);
      } finally {
        await fixture.dispose();
        await rejected;
      }
    },
    10_000,
  );

  for (const cancelled of [false, true]) {
    test.skipIf(process.platform === "win32")(
      `${name}: ${cancelled ? "cancelled" : "normal"} copy independently drains the actual SDK child`,
      async () => {
        const fixture = fakeClipboard("stall", runtime);
        const controller = new AbortController();
        const action = copySnippet(
          "private",
          { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
          fixture.write,
        );
        try {
          await waitFor(() => Object.keys(fixture.received()).length === 1, "SDK utility did not start");
          if (cancelled) {
            controller.abort();
            assert.deepEqual(await action, { copied: false, reason: "cancelled" });
            assert.ok(
              fixture.receipts().every(({ pid }) => nativePidExists(pid)),
              "ownership cancellation does not own the SDK process",
            );
            await fixture.dispose();
          } else {
            fixture.release();
            fixture.release();
            assert.deepEqual(await action, { copied: true });
            await fixture.restore();
            assert.equal(existsSync(fixture.directory), true, "restore drains but retains proof until disposal");
            await fixture.dispose();
          }
          gone(fixture);
        } finally {
          controller.abort();
          await fixture.dispose();
          await action;
        }
      },
    );
  }

  test.skipIf(process.platform === "win32")(
    `${name}: immediate synchronous failure drains a copy queued before native startup`,
    async () => {
      const fixture = fakeClipboard("stall", runtime);
      let action: ReturnType<typeof copySnippet> | undefined;
      try {
        assert.throws(() => {
          action = copySnippet(
            "queued",
            { signal: new AbortController().signal, isCurrent: () => true },
            fixture.write,
          );
          assert.fail("synchronous assertion");
        }, /synchronous assertion/);
      } finally {
        await fixture.dispose();
      }
      assert.deepEqual(await action, { copied: true });
      gone(fixture);
    },
  );

  test.skipIf(process.platform === "win32")(
    `${name}: forced WSL failure uses only owned interop guards without OSC 52`,
    async () => {
      const driverDirectory = mkdtempSync(path.join(tmpdir(), "pi-code-clipboard-wsl-driver-"));
      try {
        // Node's public os.platform observes the fixture's process.platform descriptor;
        // Bun's os.platform stays host-native. Exercise both native workers via Node's SDK.
        const child = spawn(
          runtimes[1][1],
          [fileURLToPath(new URL("./clipboard-owner.ts", import.meta.url)), "wsl-failure", runtime],
          {
            // No inherited PATH, Windows Terminal, remote/OSC 52, or WSL markers.
            env: {
              PATH: "",
              TMPDIR: driverDirectory,
              HOME: driverDirectory,
              PI_CODING_AGENT_DIR: path.join(driverDirectory, "agent"),
              XDG_CONFIG_HOME: path.join(driverDirectory, "config"),
              XDG_CACHE_HOME: path.join(driverDirectory, "cache"),
              XDG_DATA_HOME: path.join(driverDirectory, "data"),
              PI_OFFLINE: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(code, 0, stderr);
        assert.equal(stdout.includes("\x1b]52;"), false, "must not emit headless/remote/Windows Terminal OSC 52");
        const evidence = JSON.parse(stdout.trim()) as {
          directory: string;
          receipts: Array<{ pid: number }>;
          args: string[];
        };
        assert.equal(evidence.args[0], "-w", "actual SDK WSL conversion reached the private failing wslpath");
        assert.ok(evidence.receipts.length > 0, "actual SDK Linux utility must also have run");
        for (const { pid } of evidence.receipts) {
          assert.equal(nativePidExists(pid), false);
          assert.equal(nativePidExists(-pid), false);
        }
        assert.equal(existsSync(evidence.directory), false);
      } finally {
        rmSync(driverDirectory, { recursive: true, force: true });
      }
    },
    10_000,
  );

  for (const tracking of ["tracked", "untracked"]) {
    for (const route of ["headless", "wsl"]) {
      test.skipIf(process.platform === "win32")(
        `${name}: failed drain quarantines ${tracking} SDK fallback from ${route} ambient routes`,
        async () => {
          const driverDirectory = mkdtempSync(path.join(tmpdir(), "pi-code-clipboard-failed-drain-driver-"));
          const child = spawn(
            runtimes[1][1],
            [
              fileURLToPath(new URL("./clipboard-owner.ts", import.meta.url)),
              `drain-failure-${tracking}-${route}`,
              runtime,
            ],
            {
              env: {
                PATH: "",
                TMPDIR: driverDirectory,
                HOME: driverDirectory,
                PI_CODING_AGENT_DIR: path.join(driverDirectory, "agent"),
                XDG_CONFIG_HOME: path.join(driverDirectory, "config"),
                XDG_CACHE_HOME: path.join(driverDirectory, "cache"),
                XDG_DATA_HOME: path.join(driverDirectory, "data"),
                PI_OFFLINE: "1",
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          let evidence: { directory: string; receipts: Array<{ pid: number; started: boolean }> } | undefined;
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const first = stdout.split("\n")[0];
            if (!evidence && first && stdout.includes("\n")) evidence = JSON.parse(first) as typeof evidence;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          const closed = new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
          // A broken SDK/test must not leave a stopped worker or hanging owner.
          // Rescue only the exact started receipt from this private driver.
          const rescued: number[] = [];
          const rescue = () => {
            for (const { pid, started } of evidence?.receipts ?? []) {
              if (!started || !nativePidExists(pid) || !evidence) continue;
              // Revalidate private executable identity, not a process name or
              // potentially recycled numeric PID, before regression-only rescue.
              const table = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
              const command = table.split("\n").find((line) => Number(/^\s*(\d+)/.exec(line)?.[1]) === pid);
              if (command?.includes(`${evidence.directory}${path.sep}worker.mjs`)) {
                process.kill(pid, "SIGKILL");
                rescued.push(pid);
              }
            }
          };
          const watchdog = setTimeout(() => {
            rescue();
            child.kill("SIGKILL");
          }, 12_000);
          try {
            const code = await closed;
            assert.equal(
              stdout.includes("\x1b]52;"),
              false,
              `real SDK emitted OSC 52 after failed teardown: ${stdout}`,
            );
            assert.equal(code, 0, `${stderr}\n${stdout}`);
            assert.deepEqual(rescued, [], "the SDK, not test rescue, must reap every stopped worker");
            assert.ok(evidence && evidence.receipts.length > 0, "driver must expose its exact native ownership proof");
            assert.equal(
              existsSync(evidence.directory),
              true,
              "failed cleanup must retain quarantine, not declare success",
            );
            for (const { pid } of evidence.receipts) {
              assert.equal(nativePidExists(pid), false, "SDK must reap every owned worker without rescue");
              assert.equal(nativePidExists(-pid), false, "SDK must leave no owned process group");
            }
            const final = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { ambientRoutes: string[] };
            assert.deepEqual(final.ambientRoutes, []);
          } finally {
            clearTimeout(watchdog);
            rescue();
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await closed;
            rmSync(driverDirectory, { recursive: true, force: true });
            await waitFor(
              () => (evidence?.receipts ?? []).every(({ pid }) => !nativePidExists(pid) && !nativePidExists(-pid)),
              "only this driver's rescued fixture survived",
            );
          }
        },
        15_000,
      );
    }
  }

  for (const scenario of ["assertion-failure", "directory-retired", "owner-exit"]) {
    test.skipIf(process.platform === "win32")(
      `${name}: isolated ${scenario} cannot strand a fixture process`,
      async () => {
        const child = spawn(runtime, [fileURLToPath(new URL("./clipboard-owner.ts", import.meta.url)), scenario], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        let evidence: { directory: string; receipts: Array<{ pid: number }> } | undefined;
        try {
          const code = await closed;
          assert.equal(code, scenario === "assertion-failure" ? 1 : 0, stderr);
          evidence = JSON.parse(stdout.trim()) as typeof evidence;
          assert.ok(evidence && evidence.receipts.length > 0, "driver must report native PID proof");
          const { directory, receipts } = evidence;
          await waitFor(
            () => receipts.every(({ pid }) => !nativePidExists(pid) && !nativePidExists(-pid)),
            "orphan native PID/group survived",
          );
          assert.equal(existsSync(directory), scenario === "owner-exit");
        } finally {
          // Only this explicitly owned driver handle may be killed on test failure.
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await closed;
          if (!evidence && stdout.trim()) evidence = JSON.parse(stdout.trim()) as typeof evidence;
          if (evidence) {
            // Retire its marker too on failed assertions; workers self-stop without signals.
            rmSync(evidence.directory, { recursive: true, force: true });
            const receipts = evidence.receipts;
            await waitFor(() => receipts.every(({ pid }) => !nativePidExists(pid)), "driver fixture survived cleanup");
          }
        }
      },
      10_000,
    );
  }
}

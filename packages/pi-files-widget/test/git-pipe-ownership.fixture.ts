import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { mock, test } from "node:test";
import { createFileBrowser } from "../browser.js";
import { readGitMetadata } from "../git-async.js";

const theme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3500;
  while (!check() && Date.now() < deadline) await pause(10);
  assert.equal(check(), true);
}

for (const boundary of ["timeout", "cancel", "reroot", "unconfirmed-kill"] as const) {
  test(`exited Git parent with inherited pipes releases ownership on ${boundary}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "git-inherited-pipes-")));
    const childRoot = join(root, "child");
    mkdirSync(childRoot);
    const executable = join(root, "git");
    const holders = join(root, "holders");
    writeFileSync(
      executable,
      `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
if (process.cwd() === ${JSON.stringify(childRoot)}) {
  if (${boundary === "unconfirmed-kill"}) await new Promise(() => { setInterval(() => {}, 1000); });
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
  appendFileSync(${JSON.stringify(holders)}, String(holder.pid) + '\\n');
  holder.unref();
}
if (process.argv[2] === 'rev-parse') process.stdout.write('true\\n\\n');
process.exit(0);
`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}${delimiter}${previousPath ?? ""}`;
    const children: ChildProcess[] = [];
    let exited = false;
    let closes = 0;
    let confirmKill: (() => void) | undefined;
    const native = childProcess.spawn;
    const spawn = mock.method(childProcess, "spawn", (...args: Parameters<typeof native>) => {
      const child = native(...args);
      children.push(child);
      if (boundary === "unconfirmed-kill" && children.length === 1) {
        const kill = child.kill.bind(child);
        confirmKill = () => {
          kill("SIGKILL");
        };
        mock.method(child, "kill", () => true); // accepted signal is not exit evidence
      }
      child.once("exit", () => {
        exited = true;
      });
      child.once("close", () => {
        closes++;
      });
      return child;
    });
    syncBuiltinESMExports();
    const controller = new AbortController();
    let browser: ReturnType<typeof createFileBrowser> | undefined;
    let settled = 0;
    let failure: unknown;
    let pending: Promise<void> | undefined;
    try {
      if (boundary === "reroot" || boundary === "unconfirmed-kill")
        browser = createFileBrowser(
          childRoot,
          new Set(),
          theme as never,
          () => {},
          () => {},
          () => {},
        );
      else
        pending = readGitMetadata(childRoot, executable, controller.signal).then(
          () => {
            settled++;
          },
          (error: unknown) => {
            settled++;
            failure = error;
          },
        );
      await until(() => (boundary === "unconfirmed-kill" ? children.length === 1 : exited));
      assert.equal(closes, 0, "direct exit is not inherited-pipe closure");
      assert.equal(settled, 0);
      assert.ok(children[0].stdout && children[0].stderr);
      const stdout = mock.method(children[0].stdout, "destroy");
      const stderr = mock.method(children[0].stderr, "destroy");
      const remove = mock.method(controller.signal, "removeEventListener");
      if (boundary === "cancel") controller.abort();
      if (browser) browser.handleInput("u");
      if (boundary === "unconfirmed-kill") {
        await pause(50);
        assert.equal(exited, false);
        assert.equal(children.length, 1, "retired request retains the pump until direct termination is confirmed");
        assert.equal(children[0].stdout.destroyed, false);
        assert.equal(children[0].stderr.destroyed, false);
        assert.ok(confirmKill);
        confirmKill();
      }
      await until(() => (browser ? children.length > 1 : settled === 1));
      await pending;
      if (!browser) assert.match(String(failure), boundary === "timeout" ? /timed out/ : /cancelled/);
      assert.equal(stdout.mock.callCount(), 1, "owned stdout closed exactly once");
      assert.equal(stderr.mock.callCount(), 1);
      if (!browser) assert.equal(remove.mock.calls.filter(({ arguments: args }) => args[0] === "abort").length, 1);
      controller.abort();
      await pause(30);
      if (!browser) assert.equal(settled, 1);
      if (browser) {
        const currentBrowser = browser;
        await until(() => !currentBrowser.render(160)[0].includes("Git loading"));
        assert.doesNotMatch(browser.render(160)[0], /stale/);
      }
    } finally {
      browser?.dispose();
      controller.abort();
      confirmKill?.();
      if (existsSync(holders)) {
        for (const pid of readFileSync(holders, "utf8").trim().split("\n").map(Number)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
          }
          // Only fixture-owned holders; their exited parent is reaped via exit,
          // and the OS reaps the orphans. Verify no owned PID remains.
          await until(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          });
        }
      }
      await pending;
      await until(() => children.every((child) => child.exitCode !== null || child.signalCode !== null));
      spawn.mock.restore();
      syncBuiltinESMExports();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
      mock.restoreAll();
    }
  });
}

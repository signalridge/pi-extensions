// Isolated failure/abrupt-exit driver; imported by native Node and Bun, not a test runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { fakeClipboard, nativePidExists } from "./clipboard-host.ts";

const scenario = process.argv[2];

async function failedDrain() {
  const ambient = process.env.HOME;
  assert.ok(ambient, "isolated driver requires a private HOME");
  // Restoring this PATH is observable but harmless, even when the regression
  // re-enables the real SDK's WSL fallback. Never use inherited executables.
  for (const utility of ["wslpath", "powershell.exe", "clip", "clip.exe"]) {
    writeFileSync(
      path.join(ambient, utility),
      `#!/bin/sh\nprintf reached > '${path.join(ambient, `ambient-${utility}`)}'\nprintf '/private/fixture.txt\\n'\n`,
      { mode: 0o700 },
    );
  }
  process.env.PATH = ambient;
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION", "WT_SESSION", "WSLENV"]) delete process.env[key];
  if (scenario.endsWith("-wsl")) process.env.WSL_DISTRO_NAME = "ambient-fixture-distro";
  else delete process.env.WSL_DISTRO_NAME;

  const fixture = fakeClipboard("stall", process.argv[3]);
  const started = Date.now();
  // Registered extension/codeCommand tests call the public SDK directly. Those
  // promises are intentionally absent from the fixture's tracked writes set.
  const pending = scenario.includes("-untracked-")
    ? copyToClipboard("private failed-drain fixture")
    : fixture.write("private failed-drain fixture");
  let settled = false;
  const outcome = pending.then(
    () => {
      settled = true;
      return { status: "fulfilled", message: "" };
    },
    (error: unknown) => {
      settled = true;
      return { status: "rejected", message: String(error) };
    },
  );
  const deadline = Date.now() + 3000;
  while (!Object.keys(fixture.received()).length) {
    assert.ok(Date.now() < deadline, "fixture did not receive stdin");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const receipts = fixture.receipts();
  assert.equal(receipts.length, 1);
  const owned = receipts[0];
  assert.ok(owned?.started && nativePidExists(owned.pid), "must stop only the proven native fixture worker");
  assert.equal(
    Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(owned.pid)], { encoding: "utf8" }).trim()),
    process.pid,
    "SDK worker must be this isolated driver's direct child",
  );
  process.stdout.write(`${JSON.stringify({ phase: "started", directory: fixture.directory, receipts })}\n`);
  // Suspend ONLY this receipt-proven owned worker; keep the owner/lease alive.
  // Release cannot run, so the 4s drain fails before the unmodified 5s SDK timeout.
  process.kill(owned.pid, "SIGSTOP");
  const disposal = fixture.dispose();
  const cleanupError = await disposal.then(
    () => "",
    (error: unknown) => String(error),
  );
  const settledAtFailure = settled;
  const result = await outcome;
  const reapDeadline = Date.now() + 3000;
  while (nativePidExists(owned.pid) || nativePidExists(-owned.pid)) {
    assert.ok(Date.now() < reapDeadline, "SDK did not reap its stopped worker");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const ambientRoutes = ["wslpath", "powershell.exe", "clip", "clip.exe"].filter((utility) =>
    existsSync(path.join(ambient, `ambient-${utility}`)),
  );
  process.stdout.write(
    `${JSON.stringify({ phase: "finished", directory: fixture.directory, receipts: fixture.receipts(), cleanupError, result, ambientRoutes })}\n`,
  );
  assert.match(cleanupError, /children survived teardown/, "failed drain must never report cleanup success");
  if (!scenario.includes("-untracked-")) {
    assert.equal(settledAtFailure, true, "tracked SDK promises must settle even before cleanup rejects");
  }
  assert.ok(
    fixture.receipts().every(({ completed }) => !completed),
    "SDK SIGKILL cannot run completion handlers",
  );
  assert.ok(Date.now() - started >= 5000, "must exercise the real SDK 5000 ms timeout");
  assert.equal(fixture.dispose(), disposal, "failed disposal remains idempotently rejected");
  await assert.rejects(fixture.restore(), /children survived teardown/);
  assert.equal(process.env.PATH, fixture.directory, "failed drain must quarantine PATH, including untracked SDK work");
  assert.equal(process.platform, "linux", "failed drain must not restore platform");
  assert.equal(process.env.WAYLAND_DISPLAY, "pi-code-actions-test", "headless fallback must remain disabled");
  for (const key of [
    "DISPLAY",
    "TERMUX_VERSION",
    "WSL_DISTRO_NAME",
    "WSLENV",
    "WT_SESSION",
    "PI_CLIPBOARD_OSC52",
    "SSH_CONNECTION",
    "SSH_CLIENT",
    "MOSH_CONNECTION",
  ]) {
    assert.equal(process.env[key], undefined, `failed drain restored ${key}`);
  }
  assert.equal(existsSync(fixture.directory), true, "private guards must survive until isolated owner retirement");
  assert.deepEqual(ambientRoutes, [], "no ambient Windows interop route may run");
  assert.equal(result.status, "rejected", "neither Windows nor OSC 52 may turn timeout into success");
  assert.match(result.message, /Clipboard unavailable/);
  await assert.rejects(fixture.write("retired"), /fixture is retired/);
  // Deliberately do NOT restore or remove quarantine in this process. The parent
  // retires the private directory only after this isolated owner has exited.
}

if (scenario.startsWith("drain-failure-")) {
  await failedDrain();
  process.exit(0);
}

const fixture = fakeClipboard(scenario === "wsl-failure" ? "fail" : "stall", process.argv[3]);
// Force the real public SDK's WSL branch without a WSL host or private SDK patch.
if (scenario === "wsl-failure") process.env.WSL_DISTRO_NAME = "private-fixture-distro";
const pending = fixture.write("private fixture data");
// An expected failure still needs its real SDK rejection observed.
void pending.catch(() => {});
try {
  if (scenario === "wsl-failure") {
    await assert.rejects(pending, /Clipboard unavailable/);
    assert.equal(process.env.PATH, fixture.directory, "no inherited executable routes");
    for (const key of ["WT_SESSION", "PI_CLIPBOARD_OSC52", "SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"]) {
      assert.equal(process.env[key], undefined);
    }
    assert.ok(process.env.WAYLAND_DISPLAY, "a display prevents headless OSC 52 fallback");
    const args = readFileSync(path.join(fixture.directory, "blocked-wslpath"), "utf8").trim().split("\n");
    assert.equal(args[0], "-w");
    assert.match(path.basename(args[1] ?? ""), /^pi-wsl-clip-[\da-f-]+\.txt$/);
    assert.equal(existsSync(args[1] ?? ""), false, "SDK finally must remove its private transfer file");
    for (const utility of ["powershell.exe", "clip", "clip.exe"]) {
      assert.equal(existsSync(path.join(fixture.directory, `blocked-${utility}`)), false, `${utility} was reached`);
    }
    process.stdout.write(`${JSON.stringify({ directory: fixture.directory, receipts: fixture.receipts(), args })}\n`);
  } else {
    const deadline = Date.now() + 3000;
    while (!Object.keys(fixture.received()).length) {
      assert.ok(Date.now() < deadline, "fixture did not receive stdin");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const evidence = { directory: fixture.directory, receipts: fixture.receipts() };
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (scenario === "owner-exit") process.exit(0);
    // A worker may create its final completion receipt during recursive removal.
    if (scenario === "directory-retired") {
      rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
    if (scenario === "assertion-failure") assert.fail("intentional assertion failure");
    await fixture.dispose();
    await pending;
  }
} finally {
  await fixture.dispose();
  if (scenario === "wsl-failure") assert.equal(process.env.WSL_DISTRO_NAME, undefined, "WSL environment restored");
}

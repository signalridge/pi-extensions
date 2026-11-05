import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  disposition,
  pidfdHelperPath,
  rescueKnown,
  sameIdentity,
  snapshot,
} from "./fixtures/snippet-retirement-observer.mjs";

export const BASELINE = "c00f9f990f201340b27658dcb525ddcdb14c08ec";
export const TEST_NAME = "session_before_tree waits for real TERM-resistant children and suppresses stale output";
export const LIMITS = { startup: 5000, grace: 250, wait: 1000, test: 10000, retire: 3000, observe: 4000 };
const here = path.dirname(fileURLToPath(import.meta.url));
const observerPath = path.join(here, "fixtures/snippet-retirement-observer.mjs");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const json = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

export function replaceOnce(source, oldText, newText) {
  assert.equal(source.split(oldText).length, 2, `diagnostic anchor must match exactly once: ${oldText.slice(0, 65)}`);
  return source.replace(oldText, newText);
}

export function instrument(test, runtime, observerURL) {
  const originalAlive = `function alive(pid: number) {
  try {
    process.kill(pid, 0);
    // A killed orphan can remain a zombie under a container's non-reaping PID 1.
    if (process.platform === "linux") return !/^\\d+ \\(.*\\) Z /.test(readFileSync(\`/proc/\${pid}/stat\`, "utf8"));
    return true;
  } catch {
    return false;
  }
}`;
  test = replaceOnce(test, originalAlive, "const alive = observer.alive;");
  test = replaceOnce(
    test,
    '  const pids = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).map(Number) : []);',
    '  const pids = () => observer.registerPids((existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).map(Number) : []), cwd);',
  );
  test = replaceOnce(
    test,
    '      await waitFor(() => pids().length === 2, "child/grandchild did not start");',
    '      await waitFor(() => pids().length === 2, "child/grandchild did not start");\n      observer.ready();',
  );
  test = replaceOnce(
    test,
    `      for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
      await waitFor(() => pids().every((pid) => !alive(pid)), "fixture survived teardown");
      rmSync(cwd, { recursive: true, force: true });`,
    "      await observer.cleanup(pids(), cwd);",
  );
  test = replaceOnce(
    test,
    "          handlers.set(name, handler);",
    "          handlers.set(name, () => observer.retire(name, handler));",
  );
  runtime = replaceOnce(runtime, "  let exited = false;", "  observer.supervisor(child);\n  let exited = false;");
  runtime = replaceOnce(
    runtime,
    "      process.kill(-pid, signal);",
    '      observer.mark("group-signal-call", { pid, pgid: pid, signal });\n      process.kill(-pid, signal);\n      observer.mark("group-signal-return", { pid, pgid: pid, signal });',
  );
  runtime = replaceOnce(
    runtime,
    '      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;',
    '      observer.mark("group-signal-error", { pid, pgid: pid, signal, errno: (error as NodeJS.ErrnoException).code });\n      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;',
  );
  const prefix = `import * as observer from ${JSON.stringify(observerURL)};\n`;
  return { test: prefix + test, runtime: prefix + runtime };
}

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`diagnostic prerequisite failed: ${path.basename(executable)} ${args[0]}`);
  return result.stdout.trim();
}

function files(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((item) => {
      if (item.name === "node_modules" || item.name === ".git") return [];
      const relative = path.join(prefix, item.name);
      return item.isDirectory() ? files(path.join(directory, item.name), relative) : [relative];
    })
    .sort();
}

function eventsAt(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function adjudicate(rounds, primary) {
  const baselineFailures = rounds.filter(
    (round) => round.arm === "baseline" && round.outcome === "original-assertion-failure",
  ).length;
  const fixedFailures = rounds.filter((round) => round.arm === "candidate" && round.outcome !== "pass").length;
  const invalid = rounds.some(
    (round) =>
      !round.cleanupConfirmed ||
      round.sentinelPreserved === false ||
      ["setup-or-other-failure", "watchdog"].includes(round.outcome),
  );
  const forced = rounds.some((round) => round.rescue);
  return {
    harnessSuccess: !invalid && fixedFailures === 0 && !forced,
    baselineFailures,
    fixedFailures,
    forced,
    evidence:
      baselineFailures === 0
        ? "INCONCLUSIVE: baseline failure not reproduced"
        : primary
          ? "REPRODUCED: inspect pre-rescue predicates and natural/forced timeline; human adjudication required"
          : "SECONDARY ONLY: reproduction does not satisfy native primary evidence gate",
    closureAuthorized: false,
  };
}

export function summarize(rounds, requestedPairs, primary) {
  const result = adjudicate(rounds, primary);
  const complete = rounds.length === requestedPairs * 2;
  return {
    ...result,
    harnessSuccess: result.harnessSuccess && complete,
    evidence: complete ? result.evidence : `INCOMPLETE: ${result.evidence}`,
    complete,
    completedRounds: rounds.length,
    requestedPairs,
    results: rounds,
  };
}

// Emergency path never starts another round. It records/observes before signals,
// and can touch only identities already persisted by this fixture or our child.
async function emergency(initial, evidence, output, sentinelPid, isClosed) {
  const events = eventsAt(evidence);
  const known = new Map([[initial.pid, initial.stat]]);
  for (const event of events) {
    const items = event.snapshots ?? (event.snapshot ? [event.snapshot] : []);
    for (const item of items) if (item.stat && !known.has(item.pid)) known.set(item.pid, item.stat);
  }
  const timeline = [];
  const record = (kind) => {
    const entry = {
      kind,
      wall: new Date().toISOString(),
      monotonic: performance.now(),
      snapshots: [...known.keys()].map(snapshot),
    };
    timeline.push(entry);
    json(output, timeline);
    return entry.snapshots;
  };
  const quiet = (items) => items.every((item) => ["absent", "zombie-or-dead"].includes(disposition(item)));
  let last = record("emergency-pre-rescue-start");
  const until = performance.now() + LIMITS.observe;
  while (!quiet(last) && performance.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    last = [...known.keys()].map(snapshot);
  }
  record("emergency-pre-rescue-end");
  record("emergency-rescue-start");
  const rescueConfirmed = rescueKnown(
    known,
    [...known.keys()].map(snapshot),
    (kind, data) => {
      timeline.push({ kind, ...data });
      json(output, timeline); // Durable intent before any helper rescue.
    },
    "emergency-rescue",
    { forbidden: [sentinelPid] },
  );
  const reapUntil = performance.now() + 1000;
  while ((!isClosed() || !quiet([...known.keys()].map(snapshot))) && performance.now() < reapUntil) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const final = record("emergency-final");
  timeline.push({
    kind: "emergency-cleanup-result",
    confirmed: rescueConfirmed && isClosed() && quiet(final),
    workerClosed: isClosed(),
  });
  json(output, timeline);
}

async function round(arm, pair, output, bun, sentinelPid) {
  const evidence = path.join(output, `${String(pair).padStart(3, "0")}-${arm.name}.jsonl`);
  const child = spawn(bun, ["test", "test/snippet-process.test.ts", "--test-name-pattern", `^${TEST_NAME}$`], {
    cwd: arm.privatePackage,
    env: { ...process.env, SNIPPET_DIAGNOSTIC_EVIDENCE: evidence, SNIPPET_DIAGNOSTIC_SENTINEL: String(sentinelPid) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const initial = snapshot(child.pid);
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  let text = "";
  // Retain only a bounded diagnostic reporter in memory; never upload source or output dumps.
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      text = (text + data).slice(-65536);
    });
  let timer;
  const status = await Promise.race([
    new Promise((resolve) => {
      child.once("error", () => resolve({ code: null, setup: true }));
      child.once("close", (code) => resolve({ code }));
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ watchdog: true }), 14000);
    }),
  ]);
  clearTimeout(timer);
  const messages = ["repeated retirement must await in-flight cleanup", "event must await cleanup before returning"];
  const assertions = messages.filter((message) => text.includes(message));
  const cleanupFile = `${evidence}.cleanup.json`;
  const cleanupConfirmed = existsSync(cleanupFile) && JSON.parse(readFileSync(cleanupFile, "utf8")).cleanupConfirmed;
  const events = eventsAt(evidence);
  const firstReturn = events.findIndex((event) => event.kind === "retire-return");
  const rawFailure =
    firstReturn >= 0 &&
    events.slice(firstReturn + 1).some((event) => event.kind === "alive-predicate" && event.result === true);
  const result = {
    arm: arm.name,
    pair,
    outcome: status.watchdog
      ? "watchdog"
      : status.code === 0 && events.some((event) => event.kind === "fixture-ready")
        ? "pass"
        : arm.name === "baseline" &&
            assertions.length &&
            rawFailure &&
            events.some((event) => event.kind === "fixture-ready")
          ? "original-assertion-failure"
          : "setup-or-other-failure",
    assertions,
    code: status.code,
    cleanupConfirmed: Boolean(cleanupConfirmed),
    rescue: events.some((event) => event.kind === "rescue-start"),
    reporterSHA256: hash(text),
  };
  if (!cleanupConfirmed || status.watchdog) {
    await emergency(initial, evidence, `${evidence}.emergency.json`, sentinelPid, () => closed);
    result.abort = true;
  }
  json(`${evidence}.result.json`, result);
  return result;
}

async function main() {
  const [baselineRoot, candidateRoot, outputRoot, roundsInput = "200", mode = "primary"] = process.argv.slice(2);
  assert.ok(
    baselineRoot && candidateRoot && outputRoot,
    "usage: node scripts/snippet-retirement-diagnostics.mjs BASELINE_DIR CANDIDATE_DIR OUTPUT_DIR [PAIRS=200] [primary|secondary]",
  );
  const pairs = Number(roundsInput);
  assert.ok(Number.isInteger(pairs) && pairs >= 1 && pairs <= 1000, "pairs must be in [1,1000]");
  assert.ok(["primary", "secondary"].includes(mode));
  assert.equal(process.platform, "linux", "diagnostics require Linux /proc");
  if (mode === "primary") {
    assert.equal(process.arch, "x64", "native primary requires x64");
    assert.equal(process.versions.node, "24.21.0", "primary requires Node 24.21.0");
    assert.equal(process.env.ImageOS, "ubuntu24", "primary must run on the recorded GitHub ubuntu-24.04 host");
  }
  const output = path.resolve(outputRoot);
  assert.ok(!existsSync(output) || readdirSync(output).length === 0, "output must be empty");
  mkdirSync(output, { recursive: true });
  const bun = command("which", ["bun"]);
  assert.equal(command(bun, ["--version"]), "1.3.14");
  const python = command("which", ["python3"]);
  const pidfd = JSON.parse(command(python, [pidfdHelperPath, "--probe"]));
  assert.equal(pidfd.supported, true, "Linux Python >=3.9 and functioning pidfd APIs are mandatory; no fallback");
  process.env.SNIPPET_DIAGNOSTIC_PYTHON = realpathSync(python);
  json(path.join(output, "pidfd.json"), {
    ...pidfd,
    executableSHA256: hash(readFileSync(pidfd.executable)),
    helperSHA256: hash(readFileSync(pidfdHelperPath)),
  });
  const arms = [];
  const results = [];
  let sentinel;
  let sentinelIdentity;
  try {
    for (const [name, rootInput] of [
      ["baseline", baselineRoot],
      ["candidate", candidateRoot],
    ]) {
      const root = realpathSync(rootInput);
      const revision = command("git", ["rev-parse", "HEAD"], root);
      if (name === "baseline") assert.equal(revision, BASELINE, "baseline must be the immutable failed source");
      assert.equal(
        command("git", ["status", "--porcelain", "--", "packages/pi-code-actions", "bun.lock"], root),
        "",
        "source package and lock must be clean",
      );
      const pkg = path.join(root, "packages/pi-code-actions");
      const hashes = Object.fromEntries(files(pkg).map((file) => [file, hash(readFileSync(path.join(pkg, file)))]));
      const temporary = mkdtempSync(path.join(root, ".snippet-diagnostics-"));
      const privatePackage = path.join(temporary, "package");
      arms.push({ name, root, temporary, privatePackage });
      cpSync(pkg, privatePackage, { recursive: true, filter: (source) => path.basename(source) !== "node_modules" });
      symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir");
      const testFile = path.join(privatePackage, "test/snippet-process.test.ts");
      const runtimeFile = path.join(privatePackage, "src/snippet-process.ts");
      const transformed = instrument(
        readFileSync(testFile, "utf8"),
        readFileSync(runtimeFile, "utf8"),
        pathToFileURL(observerPath).href,
      );
      writeFileSync(testFile, transformed.test);
      writeFileSync(runtimeFile, transformed.runtime);
      json(path.join(output, `${name}-source.json`), {
        revision,
        packageHashes: hashes,
        lockSHA256: hash(readFileSync(path.join(root, "bun.lock"))),
        transformedTestSHA256: hash(transformed.test),
        transformedRuntimeSHA256: hash(transformed.runtime),
      });
    }
    json(path.join(output, "host.json"), {
      mode,
      historicalImageMatch: "NOT established: OS label is not an immutable historical image",
      limits: LIMITS,
      pairs,
      node: process.versions.node,
      bun: command(bun, ["--version"]),
      nodeSHA256: hash(readFileSync(realpathSync(process.execPath))),
      bunSHA256: hash(readFileSync(realpathSync(bun))),
      ImageOS: process.env.ImageOS ?? null,
      ImageVersion: process.env.ImageVersion ?? null,
      runnerImage: process.env.ImageRelease ?? null,
      kernel: os.release(),
      uname: command("uname", ["-a"]),
      arch: process.arch,
      cpus: os.cpus().map((cpu) => cpu.model),
      uid: process.getuid(),
      pidNamespace: command("readlink", ["/proc/self/ns/pid"]),
      proc1: snapshot(1),
      pidfdHelperSHA256: hash(readFileSync(pidfdHelperPath)),
      observerSHA256: hash(readFileSync(observerPath)),
      orchestratorSHA256: hash(readFileSync(fileURLToPath(import.meta.url))),
    });
    // This direct child deliberately stays in the orchestrator's unrelated group.
    // It exits on stdin EOF, so sentinel teardown needs no additional signal.
    sentinel = spawn(
      process.execPath,
      ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    sentinelIdentity = snapshot(sentinel.pid);
    assert.ok(sentinelIdentity.stat, "sentinel identity must be observable");
    json(path.join(output, "sentinel.json"), { initial: sentinelIdentity });
    for (let pair = 1; pair <= pairs; pair++) {
      for (const arm of pair % 2 ? arms : [...arms].reverse()) {
        const result = await round(arm, pair, output, bun, sentinel.pid);
        const sentinelAfter = snapshot(sentinel.pid);
        result.sentinelPreserved =
          sameIdentity(sentinelIdentity.stat, sentinelAfter.stat) && disposition(sentinelAfter) === "live";
        json(path.join(output, `${String(pair).padStart(3, "0")}-${arm.name}.sentinel.json`), sentinelAfter);
        if (!result.sentinelPreserved) result.abort = true;
        results.push(result);
        json(path.join(output, "summary.json"), summarize(results, pairs, mode === "primary"));
        console.log(`${pair}/${pairs} ${arm.name}: ${result.outcome}; cleanup=${result.cleanupConfirmed}`);
        if (result.abort) throw new Error("unconfirmed cleanup: subsequent rounds aborted");
      }
    }
    const summary = summarize(results, pairs, mode === "primary");
    console.log(summary.evidence);
    if (!summary.harnessSuccess) process.exitCode = 1;
  } finally {
    if (sentinel) {
      const closed = new Promise((resolve) => sentinel.once("close", () => resolve(true)));
      sentinel.stdin.end();
      let timer;
      const reaped = await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      clearTimeout(timer);
      json(path.join(output, "sentinel.json"), { initial: sentinelIdentity, final: snapshot(sentinel.pid), reaped });
      if (!reaped) {
        sentinel.unref();
        process.exitCode = 1;
        json(path.join(output, "summary.json"), {
          ...summarize(results, pairs, mode === "primary"),
          harnessSuccess: false,
          sentinelReaped: false,
        });
      }
    }
    for (const arm of arms) rmSync(arm.temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

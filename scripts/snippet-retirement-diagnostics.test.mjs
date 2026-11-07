import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canRescue,
  disposition,
  parseStat,
  rescueKnown,
  sameIdentity,
} from "./fixtures/snippet-retirement-observer.mjs";
import { adjudicate, BASELINE, instrument, LIMITS, replaceOnce, summarize } from "./snippet-retirement-diagnostics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = "packages/pi-code-actions/src/snippet-process.ts";
const testPath = "packages/pi-code-actions/test/snippet-process.test.ts";
function original(file) {
  const result = spawnSync("git", ["show", `${BASELINE}:${file}`], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0);
  return result.stdout;
}
function stat(state = "S", start = "12345") {
  return `42 (worker (quoted) name) ${state} 11 42 42 ${Array(15).fill("0").join(" ")} ${start} 0 0`;
}

test("proc parser retains identity with spaces/parentheses in comm and raw large starttime", () => {
  assert.deepEqual(parseStat(stat("S", "999999999999999999")), {
    pid: 42,
    ppid: 11,
    pgid: 42,
    sid: 42,
    state: "S",
    starttime: "999999999999999999",
  });
  assert.throws(() => parseStat("bad stat"));
  assert.throws(() => parseStat("42 (short) S 1"));
});

test("absence, zombie, live, and permission/unknown observations remain distinct", () => {
  assert.equal(disposition({ stat: parseStat(stat("Z")) }), "zombie-or-dead");
  assert.equal(disposition({ stat: parseStat(stat("S")) }), "live");
  assert.equal(disposition({ errno: "ENOENT" }), "absent");
  assert.equal(disposition({ errno: "ESRCH" }), "absent");
  for (const errno of ["EPERM", "EACCES", "EIO", undefined]) assert.equal(disposition({ errno }), "unknown");
  assert.equal(disposition({ stat: parseStat(stat()), errno: "EPERM" }), "unknown");
});

test("PID reuse or unconfirmed identity can never qualify for rescue", () => {
  const first = parseStat(stat());
  assert.equal(sameIdentity(first, { ...first }), true);
  assert.equal(sameIdentity(first, { ...first, starttime: "54321" }), false);
  assert.equal(sameIdentity(first, { ...first, pid: 43 }), false);
  assert.equal(sameIdentity(first, undefined), false);
  assert.equal(sameIdentity(undefined, first), false);
});

test("rescue guard rejects self, unrelated/reused PIDs, zombies, and permission errors", () => {
  const expected = { ...parseStat(stat()), uid: 1000 };
  const observed = { pid: expected.pid, stat: expected };
  assert.equal(canRescue(expected, observed, 99), true);
  for (const unsafe of [
    { ...observed, pid: 99, stat: { ...expected, pid: 99 } },
    { ...observed, stat: { ...expected, starttime: "different" } },
    { ...observed, stat: { ...expected, state: "Z" } },
    { ...observed, stat: { ...expected, uid: 1001 } },
    { ...observed, stat: { ...expected, pgid: 43 } },
    { ...observed, stat: { ...expected, sid: 43 } },
    { ...observed, errno: "EPERM" },
    { pid: 42, errno: "EPERM" },
    { pid: 42, errno: "ENOENT" },
    { pid: 1 },
    { pid: -42 },
  ])
    assert.equal(canRescue(expected, unsafe, 99), false);
  assert.equal(canRescue(expected, observed, 42), false);
  assert.equal(canRescue(undefined, observed, 99), false);
  assert.equal(canRescue({ ...expected, uid: undefined }, observed, 99), false);
});

test("portable pidfd fake backend proves pinned old-task/ESRCH and pre-acquisition replacement refusal", () => {
  const run = spawnSync("python3", ["-B", path.join(root, "scripts/fixtures/snippet-retirement-pidfd.test.py")], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `${run.error ?? ""}${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /Ran 4 tests/);
});

for (const prefix of ["rescue", "emergency-rescue"]) {
  test(`${prefix}: shared dispatch persists before pidfd, refuses unknown/self/sentinel, never numeric-signals`, () => {
    const expected = { ...parseStat(stat()), uid: 1000 };
    const observed = { pid: 42, stat: expected };
    const known = new Map([[42, expected]]);
    for (const status of ["sent", "gone", "refused", "unknown"]) {
      const records = [];
      const confirmed = rescueKnown(known, [observed], (kind, data) => records.push({ kind, data }), prefix, {
        self: 99,
        forbidden: [77],
        invoke: (request) => {
          assert.deepEqual(
            records.map((item) => item.kind),
            [`${prefix}-intent`],
          );
          assert.deepEqual(request, { expected, self: 99, forbidden: [77] });
          return { status };
        },
      });
      assert.equal(confirmed, ["sent", "gone"].includes(status));
      assert.equal(records[1].data.transport, "pidfd");
    }
    for (const options of [
      { self: 42, forbidden: [77] },
      { self: 99, forbidden: [42] },
      { self: 99, forbidden: [NaN] },
    ]) {
      assert.equal(
        rescueKnown(known, [observed], () => {}, prefix, { ...options, invoke: () => assert.fail("must refuse") }),
        false,
      );
    }
    for (const unsafe of [
      { ...observed, errno: "EPERM" },
      { ...observed, stat: { ...expected, starttime: "54321" } },
    ]) {
      assert.equal(
        rescueKnown(known, [unsafe], () => {}, prefix, {
          self: 99,
          forbidden: [77],
          invoke: () => assert.fail("must refuse"),
        }),
        false,
      );
    }
    const observer = readFileSync(path.join(root, "scripts/fixtures/snippet-retirement-observer.mjs"), "utf8");
    const orchestrator = readFileSync(path.join(root, "scripts/snippet-retirement-diagnostics.mjs"), "utf8");
    assert.match(observer, /rescueConfirmed = rescueKnown\(known, allSnapshots\(\)/);
    assert.match(orchestrator, /const rescueConfirmed = rescueKnown\(\s*known,/);
    assert.doesNotMatch(observer, /process\.kill\([^,]+, "SIGKILL"\)/);
    assert.doesNotMatch(orchestrator.slice(orchestrator.indexOf("async function emergency")), /process\.kill\(/);
    assert.match(observer, /cleanupConfirmed = rescueConfirmed && quiet\(final\)/);
    assert.match(orchestrator, /result\.abort = true/);
    assert.match(orchestrator, /workerClosed: isClosed\(\)/);
    assert.match(observer, /every\(\(item\) => item\.closed\)/);
  });
}

test("workflow is same-VM, read-only, pinned, bounded and uploads evidence after failure", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/snippet-retirement-diagnostics.yml"), "utf8");
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /pull_request|workflow_run|^ {2}push:/m);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}\n {10}path: candidate/);
  assert.match(workflow, /ref: c00f9f990f201340b27658dcb525ddcdb14c08ec\n {10}path: baseline/);
  assert.match(workflow, /python3 scripts\/fixtures\/snippet-retirement-pidfd\.py --probe/);
  assert.match(
    workflow,
    /node candidate\/scripts\/snippet-retirement-diagnostics\.mjs baseline candidate diagnostic-evidence "\$PAIRS" primary/,
  );
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /default: "200"/);
  assert.match(workflow, /node-version: 24\.21\.0/);
  assert.match(workflow, /bun-version: 1\.3\.14/);
  assert.equal((workflow.match(/bun install --frozen-lockfile --ignore-scripts/g) ?? []).length, 2);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  for (const match of workflow.matchAll(/uses: (\S+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
  assert.match(workflow, /if: always\(\)[\s\S]*actions\/upload-artifact@/);
  assert.doesNotMatch(workflow, /pull_request_target|\$\{\{\s*secrets\.|id-token:|contents: write|strategy:|matrix:/);
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(manifest.scripts.test, /node --test scripts\/snippet-retirement-diagnostics\.test\.mjs/);
});

test("unique-anchor transforms fail closed", () => {
  assert.equal(replaceOnce("a b c", "b", "B"), "a B c");
  assert.throws(() => replaceOnce("aa", "a", "b"));
  assert.throws(() => replaceOnce("aa", "z", "b"));
});

test("both immutable original and candidate transform without changing assertions or production limits", () => {
  for (const load of [original, (file) => readFileSync(path.join(root, file), "utf8")]) {
    const before = load(testPath);
    const runtime = load(modulePath);
    const transformed = instrument(before, runtime, "file:///private-observer.mjs");
    const assertions = (source) => source.match(/assert\.[\s\S]*?;/g);
    assert.deepEqual(assertions(transformed.test), assertions(before));
    assert.ok(transformed.test.includes("    10_000,"));
    assert.ok(transformed.test.includes('Date.now() - before < 3000, "retirement cleanup must be bounded"'));
    for (const [name, value] of [
      ["TERM_GRACE_MS", 250],
      ["WAIT_MS", 1000],
      ["STARTUP_MS", 5000],
    ]) {
      assert.ok(transformed.runtime.includes(`const ${name} = ${value};`));
    }
    assert.ok(transformed.test.includes("observer.cleanup(pids(), cwd)"));
    assert.ok(!transformed.test.includes('for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL")'));
    assert.equal(transformed.runtime.match(/process.kill\(-pid, signal\)/g).length, 1);
    assert.equal(transformed.test.match(/observer\.ready\(\)/g).length, 1);
  }
  assert.deepEqual(LIMITS, { startup: 5000, grace: 250, wait: 1000, test: 10000, retire: 3000, observe: 4000 });
});

test("non-reproduction is inconclusive, never closure or automatic harness failure", () => {
  const rounds = ["baseline", "candidate"].map((arm) => ({
    arm,
    outcome: "pass",
    cleanupConfirmed: true,
    rescue: false,
  }));
  const result = adjudicate(rounds, true);
  assert.equal(result.harnessSuccess, true);
  assert.match(result.evidence, /INCONCLUSIVE/);
  assert.equal(result.closureAuthorized, false);
});

test("incomplete paired runs can never leave a green summary", () => {
  const pass = { arm: "baseline", outcome: "pass", cleanupConfirmed: true, rescue: false };
  assert.equal(summarize([pass], 200, true).harnessSuccess, false);
  assert.match(summarize([pass], 200, true).evidence, /INCOMPLETE/);
  assert.equal(summarize([pass, { ...pass, arm: "candidate" }], 1, true).harnessSuccess, true);
});

test("baseline assertion failure is data; fixed failures, setup, rescue, and unknown cleanup fail harness", () => {
  const failure = { arm: "baseline", outcome: "original-assertion-failure", cleanupConfirmed: true, rescue: false };
  assert.equal(adjudicate([failure], true).harnessSuccess, true);
  assert.equal(adjudicate([failure], true).closureAuthorized, false);
  assert.match(adjudicate([failure], false).evidence, /SECONDARY ONLY/);
  for (const bad of [
    { ...failure, arm: "candidate" },
    { ...failure, outcome: "setup-or-other-failure" },
    { ...failure, cleanupConfirmed: false },
    { ...failure, sentinelPreserved: false },
    { ...failure, rescue: true },
    { ...failure, outcome: "watchdog" },
  ])
    assert.equal(adjudicate([bad], true).harnessSuccess, false);
});

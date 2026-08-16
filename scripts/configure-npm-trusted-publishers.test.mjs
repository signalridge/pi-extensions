import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/configure-npm-trusted-publishers.sh");
const registryFlag = "--registry=https://registry.npmjs.org";

function publicPackageNames() {
  return readdirSync(join(root, "packages"))
    .sort()
    .flatMap((directory) => {
      const manifest = JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8"));
      return manifest.private !== true && manifest.publishConfig?.access === "public" ? [manifest.name] : [];
    });
}

function createFakeNpm(directory) {
  const npmPath = join(directory, "npm");
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.FAKE_NPM_LOG;
appendFileSync(log, JSON.stringify(args) + "\\n");
const registryFlag = ${JSON.stringify(registryFlag)};
if (args[0] === "trust" && args[1] === "github" && args[2] === "--help") {
  if (process.env.FAKE_NPM_FAIL_HELP === "1") {
    process.stderr.write("unsupported npm trust github\\n");
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === "whoami") {
  if (!args.includes(registryFlag)) process.exit(3);
  process.stdout.write("signalridge\\n");
  process.exit(0);
}
if (args[0] === "view") {
  if (!args.includes(registryFlag)) process.exit(4);
  const packageName = args[1];
  if (packageName === process.env.FAKE_NPM_MISSING) {
    process.stderr.write("npm error E404\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(packageName) + "\\n");
  process.exit(0);
}
if (args[0] === "trust" && args[1] === "github") {
  if (!args.includes(registryFlag)) process.exit(5);
  process.exit(0);
}
process.exit(6);
`,
  );
  chmodSync(npmPath, 0o755);
}

function runScript({ missingPackage, failHelp = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-trusted-publisher-test-"));
  const logPath = join(directory, "npm-calls.jsonl");
  createFakeNpm(directory);
  const result = spawnSync("bash", [script, "--yes"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      FAKE_NPM_LOG: logPath,
      FAKE_NPM_MISSING: missingPackage ?? "",
      FAKE_NPM_FAIL_HELP: failHelp ? "1" : "0",
    },
  });
  const calls = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  rmSync(directory, { recursive: true, force: true });
  return { ...result, calls };
}

test("enumerates every public package, including the pure protocol library, with the npm registry", () => {
  const names = publicPackageNames();
  const result = runScript();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[0], ["trust", "github", "--help"]);
  assert.deepEqual(result.calls[1], ["whoami", registryFlag]);

  const viewCalls = result.calls.filter((args) => args[0] === "view");
  assert.equal(viewCalls.length, names.length);
  assert.deepEqual(
    viewCalls.map((args) => args[1]),
    names,
  );
  assert.ok(viewCalls.some((args) => args[1] === "@signalridge/pi-subagents-protocol"));
  assert.ok(viewCalls.every((args) => args.includes(registryFlag)));

  const trustCalls = result.calls.filter((args) => args[0] === "trust" && args[2] !== "--help");
  assert.equal(trustCalls.length, names.length);
  assert.ok(trustCalls.every((args) => args.includes(registryFlag)));
  assert.match(result.stdout, new RegExp(`packages to configure \\(${names.length}\\)`));
});

test("avoids Bash 4-only mapfile in the macOS-compatible setup script", () => {
  assert.doesNotMatch(readFileSync(script, "utf8"), /\bmapfile\b/);
});

test("preflights all package names before any trust mutation", () => {
  const names = publicPackageNames();
  const result = runScript({ missingPackage: names.at(-1) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /npm package lookup failed/);
  assert.equal(result.calls.filter((args) => args[0] === "view").length, names.length);
  assert.equal(result.calls.filter((args) => args[0] === "trust" && args[2] !== "--help").length, 0);
});

test("checks npm trust support before login or registry lookups", () => {
  const result = runScript({ failHelp: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support.*upgrade npm.*Trusted Publishing/);
  assert.deepEqual(result.calls, [["trust", "github", "--help"]]);
});

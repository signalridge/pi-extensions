import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packagesRoot = join(root, "packages");
const TEST_FILE = /(?:^|\/)(?:test|tests)\/.*\.test\.(?:[cm]?[jt]sx?|mjs|cjs)$/;

function walk(dir, relativeTo = dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "coverage", ".git"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path, relativeTo));
    else files.push(path);
  }
  return files;
}

const packageDirs = readdirSync(packagesRoot)
  .filter((name) => statSync(join(packagesRoot, name)).isDirectory())
  .sort();
let checked = 0;
const untested = [];
for (const directory of packageDirs) {
  const packageRoot = join(packagesRoot, directory);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const testFiles = walk(packageRoot)
    .filter((path) => TEST_FILE.test(path.replaceAll("\\", "/")))
    .map((path) => path.replace(`${packageRoot}/`, "").replaceAll("\\", "/"));
  // A package with no tests at all used to be skipped silently, which let two
  // packages ship without any. The rule this file exists to enforce — that a
  // published package's behavior is covered — is not met by having nothing to
  // check.
  if (testFiles.length === 0) {
    untested.push(manifest.name);
    continue;
  }
  const command = manifest.scripts?.test;
  assert.equal(typeof command, "string", `${manifest.name} has tests but no default test script`);
  // A command that names one test file cannot silently omit a sibling test. A
  // directory/glob/vitest invocation is intentionally accepted because the
  // test runner owns recursive discovery.
  const explicitFiles = testFiles.filter((file) => command.includes(file));
  // A package may combine a recursive runner (for example Vitest over the
  // test directory) with one explicitly named native test file. Only enforce
  // the explicit-file rule when the command has no recursive test invocation.
  const hasRecursiveRunner =
    /\b(?:vitest|jest|mocha)\b[^&;]*(?:\btest\b|test[\\/][*])/u.test(command) ||
    /\bnode\s+--test\s+(?:test(?:[\\/]|\s|$)|[^\s*]+[*])/u.test(command);
  if (explicitFiles.length > 0 && !hasRecursiveRunner) {
    const uncovered = testFiles.filter((file) => !command.includes(file));
    assert.equal(uncovered.length, 0, `${manifest.name} default test script omits: ${uncovered.join(", ")}`);
  }
  checked += testFiles.length;
  console.log(`test-inventory: ${manifest.name}: ${testFiles.length} test file(s)`);
}
assert.equal(untested.length, 0, `package(s) with no test files at all: ${untested.join(", ")}`);
assert.ok(checked > 0, "no package tests discovered");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const [script, entry] of [
  ["test:config", "scripts/smoke-pi-loaders.test.mjs"],
  ["test:schema", "scripts/pi-schema.test.mjs"],
  ["smoke:pi", "scripts/smoke-pi-loaders.mjs"],
  ["smoke:source-schemas", "scripts/smoke-pi-source-schemas.mjs"],
]) {
  assert.ok(
    rootManifest.scripts[script]?.includes(`run-pi-smoke.mjs ${entry}`),
    `${entry} must run through the isolated native launcher`,
  );
}
assert.ok(
  rootManifest.scripts.check.includes("bun run test:schema"),
  "root check omits the native validator/execute matrix",
);
assert.ok(
  rootManifest.scripts["smoke:pi"].includes("bun run smoke:source-schemas"),
  "package smoke omits source schema qualification",
);
const integrationTypes = JSON.parse(readFileSync(join(root, "tsconfig.integration.json"), "utf8"));
assert.ok(
  integrationTypes.include.includes("scripts/pi-schema-inference.fixture.ts"),
  "SDK inference fixture is not typechecked",
);
console.log(
  `check-test-inventory: ${checked} package test files; native schema/execute, source/package smoke and SDK inference gates wired`,
);

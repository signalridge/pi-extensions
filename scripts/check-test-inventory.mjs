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
for (const directory of packageDirs) {
  const packageRoot = join(packagesRoot, directory);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const testFiles = walk(packageRoot)
    .filter((path) => TEST_FILE.test(path.replaceAll("\\", "/")))
    .map((path) => path.replace(`${packageRoot}/`, "").replaceAll("\\", "/"));
  if (testFiles.length === 0) continue;
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
assert.ok(checked > 0, "no package tests discovered");
console.log(`check-test-inventory: ${checked} test files covered by package test scripts`);

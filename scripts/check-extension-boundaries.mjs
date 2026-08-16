import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(root, "packages");
const rootManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assert.equal(rootManifest.private, true, "root tooling package must remain private");
assert.equal(rootManifest.pi, undefined, "root tooling package must not declare Pi resources");
assert.equal(
  (rootManifest.keywords ?? []).some((keyword) => keyword === "pi-package" || keyword === "pi-extension"),
  false,
  "root tooling package must not advertise itself as a Pi package",
);

const packageDirs = readdirSync(packagesRoot)
  .filter((name) => statSync(resolve(packagesRoot, name)).isDirectory())
  .sort();
assert.ok(packageDirs.length > 0, "packages/ must contain at least one extension package");

const manifests = new Map();
const names = new Set();
const packageEntries = new Set();

for (const directory of packageDirs) {
  const packageRoot = resolve(packagesRoot, directory);
  const manifestPath = resolve(packageRoot, "package.json");
  assert.ok(existsSync(manifestPath), `missing package manifest: packages/${directory}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.match(directory, /^pi-.+$/u, `packages/${directory} must use a pi-* directory name`);
  assert.match(
    manifest.name,
    /^@signalridge\/pi-.+$/u,
    `packages/${directory} must use an @signalridge/pi-* package name`,
  );
  assert.equal(
    manifest.name,
    `@signalridge/${directory}`,
    `packages/${directory} package name must match its directory`,
  );
  assert.notEqual(manifest.private, true, `packages/${directory} must be publishable (private=false)`);
  assert.equal(manifest.type, "module", `packages/${directory} must be an ES module`);
  assert.equal(manifest.publishConfig?.access, "public", `packages/${directory} must opt into public npm access`);
  assert.equal(
    manifest.repository?.directory,
    `packages/${directory}`,
    `packages/${directory} repository.directory is wrong`,
  );
  assert.equal(
    manifest.repository?.url,
    "https://github.com/signalridge/pi-extensions",
    `packages/${directory} repository URL is wrong`,
  );
  assert.ok(existsSync(resolve(packageRoot, "README.md")), `packages/${directory} needs README.md`);
  assert.ok(existsSync(resolve(packageRoot, "LICENSE")), `packages/${directory} needs LICENSE`);
  const isLibrary = manifest.signalridgePackage?.kind === "library";
  const lifecycle = manifest.piExtension?.lifecycle;
  if (!isLibrary) {
    assert.ok(lifecycle === "stable" || lifecycle === "experimental", `packages/${directory} has invalid lifecycle`);
  }
  const entries = manifest.pi?.extensions;
  if (!isLibrary) {
    assert.ok(Array.isArray(entries) && entries.length > 0, `packages/${directory} pi.extensions must be non-empty`);
    assert.equal(new Set(entries).size, entries.length, `packages/${directory} pi.extensions contains duplicates`);
  }
  const normalizedEntries = isLibrary ? [] : entries;
  assert.equal(names.has(manifest.name), false, `duplicate package name: ${manifest.name}`);
  names.add(manifest.name);
  manifests.set(directory, { root: packageRoot, manifest, lifecycle, entries: normalizedEntries });
  for (const entry of normalizedEntries) {
    assert.equal(typeof entry, "string", `packages/${directory} extension entries must be strings`);
    assert.ok(entry.startsWith("./"), `packages/${directory} extension entries must be package-relative: ${entry}`);
    const absolute = resolve(packageRoot, entry);
    assert.ok(existsSync(absolute), `missing package extension entry: packages/${directory}/${entry}`);
    const packageRelative = relative(packageRoot, absolute).split(sep).join("/");
    assert.ok(!packageRelative.startsWith("../") && packageRelative !== "..", `entry escapes package: ${entry}`);
    const key = `${directory}/${packageRelative}`;
    assert.equal(packageEntries.has(key), false, `duplicate extension entry: ${key}`);
    packageEntries.add(key);
    const files = manifest.files;
    if (Array.isArray(files)) {
      const topLevel = packageRelative.split("/")[0];
      assert.ok(
        files.some((pattern) => pattern === topLevel || pattern === "*" || pattern === "*.ts"),
        `packages/${directory} files must include extension entry ${packageRelative}`,
      );
    }
  }
}

function walk(dir, callback) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "coverage" || name === ".git") continue;
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) walk(path, callback);
    else callback(path);
  }
}

function checkRelativeImports(packageName, filePath, source) {
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g;
  for (const match of source.matchAll(importPattern)) {
    const imported = resolve(dirname(filePath), match[2]);
    const packageSegment = relative(packagesRoot, imported).split(sep)[0];
    if (packageSegment && packageSegment !== packageName && packageSegment !== "node_modules") {
      throw new Error(`cross-package relative import in ${relative(root, filePath)}: ${match[2]}`);
    }
  }
}

for (const [name, info] of manifests) {
  walk(info.root, (path) => {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return;
    checkRelativeImports(name, path, readFileSync(path, "utf8"));
  });
}

console.log(
  `check-extension-boundaries: ${manifests.size} independently publishable packages, ${packageEntries.size} extensions`,
);

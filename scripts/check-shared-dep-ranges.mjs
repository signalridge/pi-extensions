/**
 * Enforce one exact declared range for shared third-party runtime/peer surfaces.
 * Compare range strings, not semver intersections; development tools are out of
 * scope. See CONTRIBUTING.md#shared-dependencies.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(root, "packages");

/** Below this, "shared" is just a coincidence and a single floor is noise. */
const MIN_PACKAGES = 2;

/**
 * Dependencies allowed to carry different ranges in different packages. Each
 * entry needs a comment saying why divergence is correct there — otherwise the
 * exemption is just the bug with a name.
 */
const EXEMPT = new Set([]);

/**
 * Runtime and peer dependencies share a host; development toolchains do not.
 * Subagents intentionally runs its own lint/type/test configuration.
 */
const SECTIONS = ["dependencies", "peerDependencies"];

const manifests = readdirSync(packagesRoot)
  .filter((entry) => statSync(resolve(packagesRoot, entry)).isDirectory())
  .map((entry) => resolve(packagesRoot, entry, "package.json"))
  .filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  })
  .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) }));

const workspaceNames = new Set(manifests.map(({ manifest }) => manifest.name));

/** dependency name → section → range → the packages declaring it. */
const declared = new Map();

for (const { manifest } of manifests) {
  for (const section of SECTIONS) {
    for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
      // Workspace packages declare independently versioned internal contracts.
      if (workspaceNames.has(dependency)) continue;
      if (EXEMPT.has(dependency)) continue;
      const bySection = declared.get(dependency) ?? new Map();
      const byRange = bySection.get(section) ?? new Map();
      byRange.set(range, [...(byRange.get(range) ?? []), manifest.name]);
      bySection.set(section, byRange);
      declared.set(dependency, bySection);
    }
  }
}

const findings = [];
let sharedCount = 0;

for (const [dependency, bySection] of [...declared].sort(([a], [b]) => a.localeCompare(b))) {
  for (const [section, byRange] of [...bySection].sort(([a], [b]) => a.localeCompare(b))) {
    const packageCount = [...byRange.values()].reduce((total, names) => total + names.length, 0);
    if (packageCount < MIN_PACKAGES) continue;
    sharedCount++;
    if (byRange.size === 1) continue;
    findings.push({ dependency, section, byRange });
  }
}

if (findings.length > 0) {
  console.error("\ncheck-shared-dep-ranges: a shared dependency is declared at more than one range:\n");
  for (const { dependency, section, byRange } of findings) {
    console.error(`  ${dependency} (${section}):`);
    for (const [range, names] of [...byRange].sort(([a], [b]) => a.localeCompare(b))) {
      console.error(`    ${range}  ${names.sort().join(", ")}`);
    }
  }
  console.error(
    "\nEvery package that shares a dependency must declare the SAME range." +
      "\nDifferent floors let the lockfile install several copies at once, which" +
      "\nfor a shared UI or protocol surface means two packages disagreeing about" +
      "\nthe same contract inside one session. Pick the range actually validated" +
      "\n(normally the highest floor) and set it everywhere, then run" +
      "\n`bun install --lockfile-only`.\n",
  );
  process.exit(1);
}

console.log(
  `check-shared-dep-ranges: ${sharedCount} shared dependency declarations agree across ${manifests.length} packages`,
);

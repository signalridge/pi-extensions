/**
 * check-shared-dep-ranges.mjs — one shared dependency, one declared floor.
 *
 * A dependency that several packages import is a shared surface whether or not
 * anyone treats it as one. When each package picks its own floor, npm and bun
 * are free to satisfy each package separately, and they do: this repository had
 * `@narumitw/pi-tui-kit` declared at three disjoint floors (`^0.54.0`,
 * `^0.51.0`, `^0.49.1`) across nine packages, and the lockfile duly resolved
 * three different copies — 0.54.0, 0.51.0, and 0.49.3 — installed side by side.
 *
 * That is worse than it looks for a TUI kit. Nothing fails at install; the
 * duplicates only surface as a theme that renders one way in one extension and
 * another way in the next, or a widget contract that silently means two
 * different things in the same session. The floors also encode a claim nobody
 * checked: "0.49.1 is enough for this package" was never validated after the
 * package started using APIs added later.
 *
 * So the rule is a single declared range per shared dependency, and this script
 * is what keeps it true. It is deliberately narrow — it compares the range
 * STRINGS, not their semantics. Two ranges that happen to overlap are still a
 * finding: the point is one intentional answer per dependency, not an
 * accidental intersection.
 *
 * A dependency counts as shared once `MIN_PACKAGES` packages declare it, so a
 * dependency two packages happen to share is governed the same way as one nine
 * of them do. `EXEMPT` names the dependencies deliberately allowed to diverge;
 * it is empty, and an entry added to it should say why in a comment.
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
 * Runtime surfaces only.
 *
 * `peerDependencies` are in scope because they are the same kind of claim as a
 * dependency range ("this package works against that version") and the same
 * kind of bug when they disagree — a pi session loads every extension into ONE
 * host process, so two packages naming different host ranges are two packages
 * disagreeing about the thing they are both running inside.
 *
 * `devDependencies` are deliberately out of scope. A build tool is not a shared
 * surface: nothing loads two packages' compilers into one process, and
 * `pi-subagents` intentionally carries its own toolchain (it is excluded from
 * the root `tsconfig.json` and `biome.json` — see `docs/package-boundaries.md`).
 * Policing that here would report a deliberate arrangement as a defect on every
 * run.
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
      // Workspace-internal packages are versioned together by Changesets and
      // legitimately move at their own pace; this rule is about third-party
      // surfaces the repository does not control.
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

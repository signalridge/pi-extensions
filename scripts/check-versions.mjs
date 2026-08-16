/**
 * check-versions.mjs — every package's local version must be publishable.
 *
 * The repository declares a version per package; npm decides whether that
 * version can actually be published. Those two drifted badly once: the whole
 * workspace was set to a 1.0.0 baseline that npm never received, so for months
 * the repository read as "1.0.0 everywhere" while installs kept resolving
 * 0.16.0, 0.11.0, 0.1.0 — and Changesets, which only ever increments the local
 * number, was computing 2.0.0 from a version that had never existed. Nothing in
 * the pipeline noticed, because nothing compared the two.
 *
 * Three relations, and only one of them is a failure:
 *
 *   local < npm latest   ERROR. The publisher refuses to move a dist-tag
 *                        backward, so a release from here fails. This is the
 *                        state that actually blocks a release, and it is what
 *                        `pi-input-history` was in at the 1.0.0 baseline
 *                        (declared 1.0.0, npm already on 1.1.0-signalridge.1).
 *   local = npm latest   Fine, and the normal resting state right after a
 *                        release. Everything this repo publishes sits here
 *                        until the next changeset moves it.
 *   local > npm latest   Fine, and expected between a merge and its release.
 *                        Reported, not failed: a number that stays unreleased
 *                        for a long time is the 1.0.0 drift, but no threshold
 *                        on that is honest enough to fail a build over.
 *
 * Network: registry lookups are best-effort. A lookup that cannot complete is
 * reported and skipped rather than failed, so an offline checkout still runs
 * `bun run check`. Set `CHECK_VERSIONS_OFFLINE=1` to skip the network entirely.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import semver from "semver";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(root, "packages");
const REGISTRY = "https://registry.npmjs.org";
/** npm can be slow on a cold cache; well under a CI step's patience. */
const LOOKUP_TIMEOUT_MS = 30_000;

/** The version npm's `latest` tag resolves to, or undefined when unpublished. */
async function latestOnNpm(name) {
  try {
    const { stdout } = await execFileAsync("npm", ["view", `${name}@latest`, "version", "--registry", REGISTRY], {
      timeout: LOOKUP_TIMEOUT_MS,
      encoding: "utf8",
    });
    const version = stdout.trim();
    return version.length > 0 ? version : undefined;
  } catch (error) {
    // A name that has never been published is a 404, which is a legitimate
    // answer (the first release will bootstrap it), not a lookup failure.
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    if (/E404|404 Not Found|is not in this registry/u.test(output)) return undefined;
    throw error;
  }
}

const manifests = [];
for (const directory of readdirSync(packagesRoot).sort()) {
  const packageRoot = resolve(packagesRoot, directory);
  if (!statSync(packageRoot).isDirectory()) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  } catch {
    continue;
  }
  if (manifest.private === true || !manifest.name || !manifest.version) continue;
  manifests.push(manifest);
}

if (process.env.CHECK_VERSIONS_OFFLINE === "1") {
  console.log(`check-versions: offline, skipped ${manifests.length} registry lookups`);
  process.exit(0);
}

const behind = [];
const unreleased = [];
const unreachable = [];
const unpublished = [];

await Promise.all(
  manifests.map(async ({ name, version }) => {
    let latest;
    try {
      latest = await latestOnNpm(name);
    } catch (error) {
      unreachable.push(`${name} (${error?.shortMessage ?? error?.message ?? "lookup failed"})`);
      return;
    }
    if (latest === undefined) {
      unpublished.push(name);
      return;
    }
    if (semver.lt(version, latest)) {
      behind.push({ name, version, latest, suggested: semver.inc(latest, "minor") });
    } else if (semver.gt(version, latest)) {
      unreleased.push({ name, version, latest });
    }
  }),
);

for (const name of unreachable.sort()) console.warn(`check-versions: could not reach the registry for ${name}`);
for (const name of unpublished.sort())
  console.log(`check-versions: ${name} is not on npm yet (first release bootstraps it)`);
for (const { name, version, latest } of unreleased.sort((a, b) => a.name.localeCompare(b.name)))
  console.log(`check-versions: ${name} ${version} is not released yet (npm latest ${latest})`);

if (behind.length > 0) {
  console.error("\ncheck-versions: local version is behind npm latest:\n");
  for (const { name, version, latest, suggested } of behind.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`  ${name}: local ${version} is older than npm latest ${latest} — use ${suggested} or higher`);
  }
  console.error(
    "\nThe publisher refuses to move a dist-tag backward, so a release from here" +
      "\nwould fail. Raise the version in the package's package.json, or let" +
      "\n`bun run changeset` do it.",
  );
  process.exit(1);
}

console.log(
  `check-versions: ${manifests.length} packages checked against npm latest` +
    `${unreleased.length > 0 ? `, ${unreleased.length} awaiting release` : ""}`,
);

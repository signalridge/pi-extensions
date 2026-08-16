/**
 * check-changesets.mjs — every package whose PUBLISHED files changed must name
 * itself in a changeset.
 *
 * Versions here are independent (`fixed: []`, `linked: []` in
 * `.changeset/config.json`), which is what lets one package ship a fix without
 * dragging twenty-six unchanged packages to a new version. The cost of that
 * choice is that nothing forces the bump to exist: a package whose source
 * changed but whose name appears in no changeset is simply never released, and
 * npm keeps serving the old code while the repository looks current. That gap
 * is invisible until someone installs the package. This closes it.
 *
 * "Published files" means what the manifest's `files` array actually ships,
 * which is the only definition that matters to an installer. Tests, tsconfig,
 * and CI edits change the repository without changing the artifact, so they are
 * deliberately not a reason to demand a version.
 *
 * `CHANGELOG.md` is the one published file that is exempt. It is written BY the
 * release, not by the change being released: the Version Packages PR consumes
 * every changeset and writes the changelog in the same commit, so demanding a
 * changeset for it asks for one that was just spent — which failed that PR, and
 * therefore every release, on the first run.
 *
 * Base ref: `CHANGESET_BASE`, else `origin/<default>`, else the local default
 * branch. When none of those resolve — a shallow clone with no remote ref — the
 * check reports that it could not compare and exits 0 rather than failing a
 * build for a reason the author cannot act on. CI fetches full history, so the
 * enforcing run is the one that counts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(root, "packages");
const DEFAULT_BRANCH = "main";
/** Published files the release writes for itself; see the header. */
const RELEASE_GENERATED = new Set(["CHANGELOG.md"]);

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

/** First ref that exists, so a local checkout and a CI checkout both resolve. */
function resolveBase() {
  const candidates = [process.env.CHANGESET_BASE, `origin/${DEFAULT_BRANCH}`, DEFAULT_BRANCH].filter(
    (candidate) => typeof candidate === "string" && candidate.length > 0,
  );
  for (const candidate of candidates) {
    if (tryGit(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) return candidate;
  }
  return undefined;
}

/**
 * Paths a package publishes, as prefixes relative to the repository root.
 * A `files` entry may name a directory or a single file; both are prefix
 * matches once the directory form ends in a separator.
 */
function publishedPrefixes(directory, manifest) {
  const entries = (Array.isArray(manifest.files) && manifest.files.length > 0 ? manifest.files : ["."]).filter(
    (entry) => !RELEASE_GENERATED.has(entry.replace(/^\.\//u, "")),
  );
  return entries.map((entry) => {
    const normalized = entry.replace(/^\.\//, "").replace(/\/+$/, "");
    const full = `packages/${directory}/${normalized}`;
    const onDisk = resolve(root, full);
    const isDirectory = existsSync(onDisk) && statSync(onDisk).isDirectory();
    return isDirectory || normalized === "" ? `${full}/` : full;
  });
}

/** Package names claimed by the pending changesets, from their YAML frontmatter. */
function releasedPackages() {
  const changesetDir = resolve(root, ".changeset");
  const released = new Set();
  if (!existsSync(changesetDir)) return released;
  for (const name of readdirSync(changesetDir)) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const text = readFileSync(resolve(changesetDir, name), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1];
    if (!frontmatter) continue;
    for (const line of frontmatter.split(/\r?\n/u)) {
      // `"@scope/name": minor` — the quotes are how changesets writes it, but
      // a hand-written file may leave them off.
      const match = /^\s*["']?(@?[^"':\s]+)["']?\s*:\s*(major|minor|patch)\s*$/u.exec(line);
      if (match) released.add(match[1]);
    }
  }
  return released;
}

const base = resolveBase();
if (!base) {
  console.log("check-changesets: no base ref to compare against; skipping");
  process.exit(0);
}

const mergeBase = tryGit(["merge-base", base, "HEAD"]) ?? base;
// Working tree, not `base...HEAD`: run before committing, the change that needs
// a changeset has not reached a commit yet, and that is exactly when saying so
// is useful. On CI the tree is clean, so this is the commit diff.
const changedFiles = [
  ...git(["diff", "--name-only", mergeBase]).split("\n"),
  ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
].filter((line) => line.length > 0);

if (changedFiles.length === 0) {
  console.log(`check-changesets: no changes against ${base}`);
  process.exit(0);
}

const released = releasedPackages();
const missing = [];

for (const directory of readdirSync(packagesRoot).sort()) {
  const packageRoot = resolve(packagesRoot, directory);
  if (!statSync(packageRoot).isDirectory()) continue;
  const manifestPath = resolve(packageRoot, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private === true || !manifest.name) continue;
  if (released.has(manifest.name)) continue;

  const prefixes = publishedPrefixes(directory, manifest);
  const touched = changedFiles.filter((file) =>
    prefixes.some((prefix) => (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix)),
  );
  if (touched.length > 0) missing.push({ name: manifest.name, touched });
}

if (missing.length > 0) {
  console.error(`check-changesets: published files changed without a changeset (base ${base}):\n`);
  for (const { name, touched } of missing) {
    const shown = touched.slice(0, 5);
    console.error(`  ${name}`);
    for (const file of shown) console.error(`    ${file}`);
    if (touched.length > shown.length) console.error(`    … and ${touched.length - shown.length} more`);
  }
  console.error(
    "\nRun `bun run changeset` and select each package above." +
      "\nBump rule: major only when another package's code breaks (a removed" +
      "\nexport, a changed event/RPC payload, a protocol bump); minor for any" +
      "\nother behavior change, including retiring a config key; patch for fixes.",
  );
  process.exit(1);
}

console.log(`check-changesets: every package with published changes has a changeset (base ${base})`);

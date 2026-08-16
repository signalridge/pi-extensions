import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_DIST_TAG_LENGTH = 128;
const DIST_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_LIKE_PATTERN = /^[vV]?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/;
const RESERVED_DIST_TAGS = new Set([".", ".."]);
const PACKAGE_NAME_PATTERN = /^@signalridge\/pi-.+$/u;
const RATE_LIMIT_MAX_ATTEMPTS = 4;
const RATE_LIMIT_DELAYS_MS = [30_000, 90_000, 300_000];
export const DEFAULT_PUBLISH_COOLDOWN_MS = 10_000;

export function parsePublishCooldownMs(value = process.env.PUBLISH_COOLDOWN_MS) {
  const parsed = Number.parseInt(value ?? `${DEFAULT_PUBLISH_COOLDOWN_MS}`, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("PUBLISH_COOLDOWN_MS must be a non-negative integer");
  }
  return parsed;
}

export function validateDistTag(value) {
  if (typeof value !== "string") throw new Error("npm dist-tag must be a string");
  if (value.length === 0) throw new Error("npm dist-tag must not be empty");
  if (value !== value.trim()) throw new Error("npm dist-tag must not have leading or trailing whitespace");
  if (value.length > MAX_DIST_TAG_LENGTH) {
    throw new Error(`npm dist-tag must be at most ${MAX_DIST_TAG_LENGTH} characters`);
  }
  if (RESERVED_DIST_TAGS.has(value) || value === "--") {
    throw new Error(`npm dist-tag is reserved: ${value}`);
  }
  if (!DIST_TAG_PATTERN.test(value)) {
    throw new Error(
      "npm dist-tag contains unsafe characters; use letters, numbers, dots, underscores, or hyphens only",
    );
  }
  if (VERSION_LIKE_PATTERN.test(value)) {
    throw new Error("npm dist-tag must not look like a package version (for example 1.2.3 or v1.2)");
  }
  return value;
}

export function parseBooleanInput(value, label) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") throw new Error(`${label} must be true or false`);
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  throw new Error(`${label} must be true or false`);
}
export function packageSelections(selectionArgs) {
  if (!Array.isArray(selectionArgs) || selectionArgs.some((arg) => typeof arg !== "string")) {
    throw new Error("package selections must be strings");
  }
  return selectionArgs
    .flatMap((arg) => {
      if (arg.startsWith("--package=")) return [arg.slice("--package=".length)];
      if (arg.startsWith("--packages=")) return arg.slice("--packages=".length).split(",");
      return [];
    })
    .map((value) => value.trim());
}

export function requireSinglePackageSelection(selectionArgs, mode = "bootstrap") {
  const selections = packageSelections(selectionArgs);
  if (selections.length !== 1 || selections[0].length === 0) {
    throw new Error(`${mode} mode requires exactly one explicit package selection (use --package=<directory>)`);
  }
  return selections[0];
}

export function parsePublishArgs(argv = process.argv.slice(2), env = process.env) {
  let tag = env.PUBLISH_TAG ?? "latest";
  let includeExperimental = parseBooleanInput(
    env.PUBLISH_INCLUDE_EXPERIMENTAL ?? false,
    "PUBLISH_INCLUDE_EXPERIMENTAL",
  );
  let dryRun = false;
  let bootstrap = false;
  const selectionArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--include-experimental") {
      includeExperimental = true;
      continue;
    }
    if (arg === "--bootstrap") {
      bootstrap = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--tag") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error("--tag requires a value");
      tag = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
      continue;
    }
    if (arg.startsWith("--package=") || arg.startsWith("--packages=")) {
      selectionArgs.push(arg);
      continue;
    }
    throw new Error(`unknown publish option: ${arg}`);
  }

  if (bootstrap) requireSinglePackageSelection(selectionArgs);
  const parsed = { includeExperimental, dryRun, tag: validateDistTag(tag), selectionArgs };
  return bootstrap ? { ...parsed, bootstrap: true } : parsed;
}

export function validatePublishableIdentity(manifest) {
  const name = manifest && typeof manifest === "object" ? manifest.name : undefined;
  if (typeof name !== "string" || !PACKAGE_NAME_PATTERN.test(name)) {
    throw new Error(`publish preflight requires an @signalridge/pi-* package name: ${String(name)}`);
  }
  return manifest;
}

export function buildPublishArgs(tarball, tag) {
  return ["publish", tarball, "--access", "public", "--tag", validateDistTag(tag), "--ignore-scripts"];
}

export function buildDistTagArgs(manifest, tag) {
  return ["dist-tag", "add", `${manifest.name}@${manifest.version}`, validateDistTag(tag)];
}

export function reconcileDistTag(manifest, tag, remote) {
  const normalizedTag = validateDistTag(tag);
  if (!remote.exists) return { action: "publish", tag: normalizedTag };
  const selectedVersion = remote.distTags?.[normalizedTag];
  if (selectedVersion === manifest.version) {
    return { action: "none", tag: normalizedTag };
  }
  if (selectedVersion !== undefined) {
    if (!semver.valid(manifest.version) || !semver.valid(selectedVersion)) {
      throw new Error(
        `cannot compare npm dist-tag ${manifest.name}@${String(selectedVersion)} with ${String(manifest.version)}`,
      );
    }
    if (semver.gt(selectedVersion, manifest.version)) {
      throw new Error(
        `refusing to move npm dist-tag ${manifest.name}@${normalizedTag} backwards from ${selectedVersion} to ${manifest.version}`,
      );
    }
  }
  return { action: "repair", tag: normalizedTag, args: buildDistTagArgs(manifest, normalizedTag) };
}

export function reconcileRelease(manifest, localIntegrity, remote, { bootstrap = false } = {}) {
  if (!bootstrap && remote.packageExists === false) {
    throw new Error(
      `normal/recovery mode refuses ${manifest.name}: package name does not exist on npm; ` +
        "bootstrap exactly one package with release:publish:token or release:publish:bootstrap before retrying",
    );
  }
  if (remote.exists && remote.integrity === undefined) {
    throw new Error(
      `cannot safely resume ${manifest.name}@${manifest.version}: registry did not provide dist.integrity`,
    );
  }
  if (remote.integrity !== undefined && remote.integrity !== localIntegrity) {
    throw new Error(
      `version mismatch for ${manifest.name}@${manifest.version}: ` +
        `registry has ${remote.integrity}, local tarball is ${localIntegrity}`,
    );
  }
  return { ...manifest, existing: remote.exists };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function npmWriteOptions() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return { cwd: root, env: process.env };
  // Keep a real terminal for npm's OTP/web-auth flow while retaining stderr so
  // rate-limit failures can still be inspected and retried.
  return { cwd: root, env: process.env, stdio: ["inherit", "inherit", "pipe"] };
}
function wait(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function isRateLimitFailure(result) {
  if (!result || typeof result.status !== "number" || result.status === 0) return false;
  const diagnostic = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
  return /(?:\bE429\b|\b429\b|too many requests|rate limit)/iu.test(diagnostic);
}

export function parseRetryAfterMs(result) {
  const diagnostic = [result?.error?.message, result?.stderr, result?.stdout].filter(Boolean).join("\n");
  const seconds = diagnostic.match(/retry-after\s*[:=]\s*(\d+(?:\.\d+)?)/iu)?.[1];
  if (seconds !== undefined) return Math.ceil(Number(seconds) * 1000);
  const date = diagnostic.match(/retry-after\s*[:=]\s*([^\n\r]+)/iu)?.[1];
  if (date !== undefined) {
    const delay = Date.parse(date) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return undefined;
}

export function runWithRateLimitRetry(
  command,
  args,
  options = {},
  { execute = run, sleep = wait, maxAttempts = RATE_LIMIT_MAX_ATTEMPTS, delays = RATE_LIMIT_DELAYS_MS, onAttempt } = {},
) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const result = execute(command, args, options);
    onAttempt?.(result, attempt);
    if (!isRateLimitFailure(result) || attempt >= maxAttempts) return result;
    const delay = parseRetryAfterMs(result) ?? delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
    console.warn(`npm registry rate limit (429); retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
    sleep(delay);
  }
}

function writeCommandOutput(result) {
  if (typeof result.stdout === "string" && result.stdout.length > 0) process.stdout.write(result.stdout);
  if (typeof result.stderr === "string" && result.stderr.length > 0) process.stderr.write(result.stderr);
}

function packageIdentity(tarball) {
  const result = run("tar", ["-xOf", tarball, "package/package.json"]);
  if (result.status !== 0) throw new Error(`cannot read package manifest from ${tarball}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function integrity(tarball) {
  const digest = createHash("sha512").update(readFileSync(tarball)).digest("base64");
  return `sha512-${digest}`;
}

function localDependencyNames(manifest) {
  return new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
}

function orderReleases(releases) {
  const byName = new Map(releases.map((release) => [release.manifest.name, release]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (release) => {
    const name = release.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`local package dependency cycle includes ${name}`);
    visiting.add(name);
    for (const dependency of localDependencyNames(release.manifest)) {
      const dependencyRelease = byName.get(dependency);
      if (dependencyRelease) visit(dependencyRelease);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(release);
  };
  for (const release of releases) visit(release);
  return ordered;
}

function remoteIntegrity(manifest) {
  const packageResult = runWithRateLimitRetry("npm", ["view", manifest.name, "name", "--json"]);
  if (packageResult.status !== 0) {
    const diagnostic = `${packageResult.stderr ?? ""}\n${packageResult.stdout ?? ""}`;
    if (/\bE404\b/.test(diagnostic) || /\b404 Not Found\b/.test(diagnostic)) {
      return { packageExists: false, exists: false };
    }
    throw new Error(`npm registry package lookup failed for ${manifest.name}: ${diagnostic.trim()}`);
  }

  const result = runWithRateLimitRetry("npm", [
    "view",
    `${manifest.name}@${manifest.version}`,
    "dist.integrity",
    "--json",
  ]);
  if (result.status !== 0) {
    const diagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (/\bE404\b/.test(diagnostic) || /\b404 Not Found\b/.test(diagnostic)) {
      return { packageExists: true, exists: false };
    }
    throw new Error(`npm registry preflight failed for ${manifest.name}@${manifest.version}: ${diagnostic.trim()}`);
  }
  const value = (result.stdout ?? "").trim();
  if (!value || value === "null") return { packageExists: true, exists: true };
  try {
    const parsed = JSON.parse(value);
    return { packageExists: true, exists: true, integrity: typeof parsed === "string" ? parsed : undefined };
  } catch {
    throw new Error(`npm registry returned invalid integrity for ${manifest.name}@${manifest.version}`);
  }
}

function remoteDistTags(manifest) {
  const result = runWithRateLimitRetry("npm", ["view", manifest.name, "dist-tags", "--json"]);
  if (result.status !== 0) {
    throw new Error(
      `npm registry dist-tag lookup failed for ${manifest.name}: ${(result.stderr ?? result.stdout ?? "").trim()}`,
    );
  }
  const value = (result.stdout ?? "").trim();
  if (!value || value === "null") return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, version]) => typeof key === "string" && typeof version === "string"),
    );
  } catch {
    throw new Error(`npm registry returned invalid dist-tags for ${manifest.name}`);
  }
}

function main() {
  const { bootstrap, includeExperimental, dryRun, tag, selectionArgs } = parsePublishArgs();
  const temp = mkdtempSync(join(tmpdir(), "pi-publish-preflight-"));
  try {
    const packArgs = ["scripts/pack-packages.mjs", `--pack-destination=${temp}`, ...selectionArgs];
    if (bootstrap) packArgs.push("--exact-selection");
    if (includeExperimental) packArgs.push("--include-experimental");
    const packed = run(process.execPath, packArgs, { stdio: "inherit" });
    if (packed.status !== 0) process.exit(packed.status ?? 1);

    const tarballs = readdirSync(temp)
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => join(temp, name))
      .sort();
    if (tarballs.length === 0) throw new Error("publish preflight produced no package tarballs");
    if (bootstrap && tarballs.length !== 1) {
      throw new Error("bootstrap mode requires exactly one package tarball; publish local dependencies separately");
    }

    const releases = orderReleases(
      tarballs.map((tarball) => {
        const manifest = validatePublishableIdentity(packageIdentity(tarball));
        if (manifest.private === true) throw new Error(`refusing to publish private package ${manifest.name}`);
        if (typeof manifest.version !== "string") {
          throw new Error(`tarball ${tarball} has an invalid package identity`);
        }
        return { tarball, manifest, localIntegrity: integrity(tarball) };
      }),
    );

    // Complete all registry/content checks before publishing any package. This
    // makes a failed preflight atomic and lets a later invocation resume a
    // partial release without republishing already verified versions.
    for (const release of releases) {
      const remote = remoteIntegrity(release.manifest);
      const reconciled = reconcileRelease(release.manifest, release.localIntegrity, remote, { bootstrap });
      release.existing = reconciled.existing;
      release.tagState = release.existing
        ? reconcileDistTag(release.manifest, tag, { ...remote, distTags: remoteDistTags(release.manifest) })
        : reconcileDistTag(release.manifest, tag, remote);
      console.log(
        `preflight: ${release.manifest.name}@${release.manifest.version} ` +
          (release.existing
            ? `already published with matching integrity; tag=${release.tagState.action}`
            : `ready (${release.localIntegrity})`),
      );
    }

    if (dryRun) {
      console.log("publish-packages: preflight passed (dry-run)");
    } else {
      const cooldownMs = parsePublishCooldownMs();
      let writeCount = 0;
      const waitBetweenWrites = () => {
        if (writeCount > 0 && cooldownMs > 0) wait(cooldownMs);
        writeCount += 1;
      };
      for (const release of releases) {
        if (release.existing) {
          if (release.tagState.action !== "repair") continue;
          waitBetweenWrites();
          console.log(`\n== npm dist-tag repair ${release.manifest.name}@${release.manifest.version} (${tag}) ==`);
          const tagResult = runWithRateLimitRetry("npm", release.tagState.args, npmWriteOptions(), {
            onAttempt: writeCommandOutput,
          });
          if (tagResult.status !== 0) process.exit(tagResult.status ?? 1);
          continue;
        }
        waitBetweenWrites();
        console.log(`\n== npm publish ${release.manifest.name}@${release.manifest.version} (${tag}) ==`);
        const result = runWithRateLimitRetry("npm", buildPublishArgs(release.tarball, tag), npmWriteOptions(), {
          onAttempt: writeCommandOutput,
        });
        if (result.status !== 0) {
          const remoteAfterFailure = remoteIntegrity(release.manifest);
          if (remoteAfterFailure.exists) {
            reconcileRelease(release.manifest, release.localIntegrity, remoteAfterFailure);
            const tagState = reconcileDistTag(release.manifest, tag, {
              ...remoteAfterFailure,
              distTags: remoteDistTags(release.manifest),
            });
            if (tagState.action === "repair") {
              const tagResult = runWithRateLimitRetry("npm", tagState.args, npmWriteOptions(), {
                onAttempt: writeCommandOutput,
              });
              if (tagResult.status !== 0) process.exit(tagResult.status ?? 1);
            }
            continue;
          }
          process.exit(result.status ?? 1);
        }
      }
      console.log("publish-packages: release complete; rerunning this command is safe for matching versions");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

export { MAX_DIST_TAG_LENGTH, RATE_LIMIT_DELAYS_MS, RATE_LIMIT_MAX_ATTEMPTS, VERSION_LIKE_PATTERN };

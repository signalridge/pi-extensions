import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";
import { validateDistTag } from "./publish-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const registry = "https://registry.npmjs.org";
const defaultRetryDelaysMs = [30_000, 90_000, 300_000];
export const DEFAULT_PUBLISH_COOLDOWN_MS = 10_000;
export const DEFAULT_RELEASE_BRANCH = "changeset-release/main";
export const DEFAULT_RELEASE_BASE_BRANCH = "main";
const githubApiBase = "https://api.github.com";

function diagnostic(result) {
  return [result?.error?.message, result?.stderr, result?.stdout].filter(Boolean).join("\n");
}

export function isRateLimitFailure(result) {
  if (!result || typeof result.status !== "number" || result.status === 0) return false;
  return /(?:\bE429\b|\b429\b|too many requests|rate limit)/iu.test(diagnostic(result));
}

export function parseRetryAfterMs(result) {
  const text = diagnostic(result);
  const seconds = text.match(/retry-after\s*[:=]\s*(\d+(?:\.\d+)?)/iu)?.[1];
  if (seconds !== undefined) {
    const delay = Number(seconds) * 1000;
    return Number.isFinite(delay) ? Math.ceil(delay) : undefined;
  }
  const date = text.match(/retry-after\s*[:=]\s*([^\n\r]+)/iu)?.[1];
  if (date !== undefined) {
    const delay = Date.parse(date.trim()) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return undefined;
}

export function retryDelayMs(result, attempt, delays = defaultRetryDelaysMs) {
  return parseRetryAfterMs(result) ?? delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)] ?? 0;
}

export function parseVersionsOutput(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") return [];
  const parsed = JSON.parse(stdout.trim());
  if (Array.isArray(parsed)) return parsed.filter((version) => typeof version === "string");
  if (typeof parsed === "string") return [parsed];
  return [];
}

export function assertDistTagDoesNotRegress({ packageName, version, tag, remoteVersion }) {
  if (remoteVersion === undefined) return;
  if (!semver.valid(version) || !semver.valid(remoteVersion)) {
    throw new Error(`cannot compare npm dist-tag ${packageName}@${String(remoteVersion)} with ${String(version)}`);
  }
  if (semver.gt(remoteVersion, version)) {
    throw new Error(
      `refusing to move npm dist-tag ${packageName}@${tag} backwards from ${remoteVersion} to ${version}`,
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== "string" || typeof version !== "string" || version.trim() === "") return undefined;
  const expectedVersion = version.trim();
  const heading = new RegExp(
    `^##\\s+(?:${escapeRegExp(expectedVersion)}|\\[${escapeRegExp(expectedVersion)}\\])(?:\\s|$)`,
    "u",
  );
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/u.test(line));
  const section = lines
    .slice(start, end < 0 ? lines.length : end)
    .join("\n")
    .trim();
  return section === "" ? undefined : section;
}

export function isQualifyingReleasePullRequest(
  pullRequest,
  { releaseBranch = DEFAULT_RELEASE_BRANCH, baseBranch = DEFAULT_RELEASE_BASE_BRANCH, currentRepository } = {},
) {
  return (
    typeof pullRequest?.merged_at === "string" &&
    pullRequest.merged_at.length > 0 &&
    pullRequest.head?.ref === releaseBranch &&
    pullRequest.base?.ref === baseBranch &&
    typeof currentRepository === "string" &&
    currentRepository.length > 0 &&
    pullRequest.head?.repo?.full_name === currentRepository
  );
}

export function hasQualifyingReleasePullRequest(
  pullRequests,
  { releaseBranch = DEFAULT_RELEASE_BRANCH, baseBranch = DEFAULT_RELEASE_BASE_BRANCH, currentRepository } = {},
) {
  return (
    Array.isArray(pullRequests) &&
    pullRequests.some((pullRequest) =>
      isQualifyingReleasePullRequest(pullRequest, { releaseBranch, baseBranch, currentRepository }),
    )
  );
}

export function isValidReleasePullRequestMetadata(pullRequest) {
  const number = pullRequest?.number;
  const sha = pullRequest?.head?.sha;
  return Number.isSafeInteger(number) && number > 0 && typeof sha === "string" && sha.length > 0 && sha.trim() === sha;
}

export function findQualifyingReleasePullRequest(
  pullRequests,
  { releaseBranch = DEFAULT_RELEASE_BRANCH, baseBranch = DEFAULT_RELEASE_BASE_BRANCH, currentRepository } = {},
) {
  if (!Array.isArray(pullRequests)) return undefined;
  return pullRequests.find((pullRequest) =>
    isQualifyingReleasePullRequest(pullRequest, { releaseBranch, baseBranch, currentRepository }),
  );
}

export function packageDirectoryFromPath(filePath) {
  const match = /^packages\/([^/\\]+)\/package\.json$/u.exec(filePath);
  const directory = match?.[1];
  if (!directory || directory === "." || directory === "..") return undefined;
  return directory;
}

export function snapshotPackagePath(directory) {
  const packageManifestPath = `packages/${directory}/package.json`;
  if (packageDirectoryFromPath(packageManifestPath) !== directory) {
    throw new Error(`invalid package directory: ${String(directory)}`);
  }
  return `packages/${directory}`;
}

export function selectPublishCandidates(packages, changedDirectories, remoteVersions) {
  const candidates = [];
  const existingChanged = [];
  const unbootstrapped = [];

  for (const pkg of packages) {
    if (!changedDirectories.has(pkg.workspaceDirectory)) continue;
    const remote = remoteVersions.get(pkg.manifest.name);
    if (!remote?.exists) {
      unbootstrapped.push(pkg.manifest.name);
      continue;
    }
    if (!remote.versions.has(pkg.manifest.version)) {
      candidates.push(pkg);
      continue;
    }
    existingChanged.push(pkg);
  }

  return { candidates, existingChanged, unbootstrapped };
}

export function orderPublishPackages(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  const visit = (pkg) => {
    if (visited.has(pkg.manifest.name)) return;
    if (visiting.has(pkg.manifest.name)) {
      throw new Error(`local package dependency cycle includes ${pkg.manifest.name}`);
    }
    visiting.add(pkg.manifest.name);
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      const dependencyPackage = byName.get(dependency);
      if (dependencyPackage) visit(dependencyPackage);
    }
    for (const dependency of Object.keys(pkg.manifest.optionalDependencies ?? {})) {
      const dependencyPackage = byName.get(dependency);
      if (dependencyPackage) visit(dependencyPackage);
    }
    for (const dependency of Object.keys(pkg.manifest.peerDependencies ?? {})) {
      const dependencyPackage = byName.get(dependency);
      if (dependencyPackage) visit(dependencyPackage);
    }
    visiting.delete(pkg.manifest.name);
    visited.add(pkg.manifest.name);
    ordered.push(pkg);
  };

  for (const pkg of packages) visit(pkg);
  return ordered;
}

export function buildPublishArgs(tarball, tag) {
  return ["publish", tarball, "--access", "public", "--tag", validateDistTag(tag), "--ignore-scripts", "--provenance"];
}

function wait(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runNpm(args, options = {}) {
  return spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_registry: registry },
    ...options,
  });
}

function writeOutput(result) {
  if (typeof result.stdout === "string" && result.stdout.length > 0) process.stdout.write(result.stdout);
  if (typeof result.stderr === "string" && result.stderr.length > 0) process.stderr.write(result.stderr);
}

function runView(args) {
  for (let attempt = 1; attempt <= defaultRetryDelaysMs.length + 1; attempt += 1) {
    const result = runNpm(["view", ...args, "--json"]);
    if (result.status === 0 || !isRateLimitFailure(result) || attempt > defaultRetryDelaysMs.length) {
      return result;
    }
    const delay = retryDelayMs(result, attempt);
    console.warn(`npm registry rate limit (429); retrying view in ${delay}ms (attempt ${attempt + 1})`);
    wait(delay);
  }
  throw new Error("unreachable retry loop");
}

function isNotFound(result) {
  return /\bE404\b|\b404 Not Found\b/iu.test(diagnostic(result));
}

function readManifest(directory) {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function readSnapshotPackages(snapshotRoot, changedDirectories) {
  return [...changedDirectories]
    .sort()
    .map((workspaceDirectory) => {
      snapshotPackagePath(workspaceDirectory);
      const directory = join(snapshotRoot, "packages", workspaceDirectory);
      return {
        directory,
        workspaceDirectory,
        manifest: readManifest(directory),
      };
    })
    .filter((pkg) => pkg.manifest.private !== true);
}

const releaseSubjectPatterns = [/^chore\(release\):\s*version packages(?:\s|$)/iu, /^version packages(?:\s|$)/iu];

export function isVersionPackagesReleaseSubject(subject) {
  return typeof subject === "string" && releaseSubjectPatterns.some((pattern) => pattern.test(subject.trim()));
}

function parentSubject(parentSubjects, parent) {
  if (parentSubjects instanceof Map) return parentSubjects.get(parent);
  if (parentSubjects && typeof parentSubjects === "object") return parentSubjects[parent];
  return undefined;
}

export function selectReleaseTransition({ head, headSubject, parents, parentSubjects = new Map() }) {
  if (typeof head !== "string" || !Array.isArray(parents)) return undefined;
  // Direct, normal, and squash merges leave the Version Packages commit at HEAD.
  if (isVersionPackagesReleaseSubject(headSubject)) {
    return { releaseCommit: head, form: "head" };
  }
  // A non-squash merge has the release branch as its second parent. Inspect only
  // that parent; never walk backwards through history looking for an old release.
  const secondParent = parents[1];
  if (
    typeof secondParent === "string" &&
    isVersionPackagesReleaseSubject(parentSubject(parentSubjects, secondParent))
  ) {
    return { releaseCommit: secondParent, form: "second-parent" };
  }
  return undefined;
}

function runGit(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function gitText(args, description) {
  const result = runGit(args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${description}: ${diagnostic(result)}`);
  return (result.stdout ?? "").trim();
}

async function readChangedPackageDirectories() {
  const currentHead = gitText(["rev-parse", "HEAD"], "could not inspect current HEAD");
  const parentLine = gitText(
    ["rev-list", "--parents", "-n", "1", currentHead],
    "could not inspect current HEAD parents",
  );
  const parents = parentLine.split(/\s+/u).slice(1);
  const headSubject = gitText(["log", "-1", "--format=%s", currentHead], "could not inspect current HEAD subject");
  const parentSubjects = new Map();
  const secondParent = parents[1];
  if (secondParent) {
    parentSubjects.set(
      secondParent,
      gitText(["log", "-1", "--format=%s", secondParent], "could not inspect release merge parent"),
    );
  }
  const transition = selectReleaseTransition({
    head: currentHead,
    headSubject,
    parents,
    parentSubjects,
  });
  if (!transition) return undefined;

  const pullRequest = await requireReleasePullRequest(currentHead);
  const snapshotSha = fetchReleasePullRequestHead(pullRequest);
  const releaseCommit = transition.releaseCommit;
  const baseCommit = gitText(["rev-parse", `${releaseCommit}^`], "could not find the release commit parent");
  const result = runGit(["diff", "--name-only", "-z", baseCommit, releaseCommit, "--", "packages/*/package.json"]);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not inspect the release commit: ${diagnostic(result)}`);

  const changedDirectories = new Set();
  for (const filePath of (result.stdout ?? "").split("\0").filter(Boolean)) {
    const directory = packageDirectoryFromPath(filePath);
    if (directory === undefined) {
      throw new Error(`release commit contains an invalid package manifest path: ${filePath}`);
    }
    changedDirectories.add(directory);
  }
  return { ...transition, currentHead, pullRequest, snapshotSha, changedDirectories };
}

export async function classifyCurrentReleaseTransition(readTransition = readChangedPackageDirectories) {
  return (await readTransition()) !== undefined;
}

function readRemoteVersions(manifest) {
  const result = runView([manifest.name, "versions"]);
  if (result.status !== 0) {
    if (isNotFound(result)) return { exists: false, versions: new Set() };
    throw new Error(`npm registry lookup failed for ${manifest.name}: ${diagnostic(result).trim()}`);
  }
  try {
    return { exists: true, versions: new Set(parseVersionsOutput(result.stdout)) };
  } catch (error) {
    throw new Error(`npm registry returned invalid versions for ${manifest.name}: ${error}`);
  }
}

function readRemoteDistTag(manifest, tag) {
  const result = runView([manifest.name, `dist-tags.${tag}`]);
  if (result.status !== 0) {
    if (isNotFound(result)) return undefined;
    throw new Error(`npm dist-tag lookup failed for ${manifest.name}@${tag}: ${diagnostic(result).trim()}`);
  }
  const value = (result.stdout ?? "").trim();
  if (!value || value === "null") return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed === null) return undefined;
    if (typeof parsed !== "string") throw new Error("expected a string");
    return parsed;
  } catch (error) {
    throw new Error(`npm registry returned an invalid ${tag} dist-tag for ${manifest.name}: ${error}`);
  }
}

function readRemoteIntegrity(manifest) {
  const result = runView([`${manifest.name}@${manifest.version}`, "dist.integrity"]);
  if (result.status !== 0) {
    if (isNotFound(result)) return { exists: false };
    throw new Error(
      `npm registry lookup failed for ${manifest.name}@${manifest.version}: ${diagnostic(result).trim()}`,
    );
  }
  const value = (result.stdout ?? "").trim();
  if (!value || value === "null") return { exists: true, integrity: undefined };
  try {
    const parsed = JSON.parse(value);
    return { exists: true, integrity: typeof parsed === "string" ? parsed : undefined };
  } catch (error) {
    throw new Error(`npm registry returned invalid integrity for ${manifest.name}@${manifest.version}: ${error}`);
  }
}

function packPackage(pkg, destination) {
  const result = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: pkg.directory,
    encoding: "utf8",
    env: { ...process.env, npm_config_registry: registry },
  });
  writeOutput(result);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed for ${pkg.manifest.name}: ${diagnostic(result)}`);
  const parsed = JSON.parse((result.stdout ?? "").trim());
  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!info || info.name !== pkg.manifest.name || info.version !== pkg.manifest.version) {
    throw new Error(`npm pack returned the wrong identity for ${pkg.manifest.name}`);
  }
  if (typeof info.filename !== "string" || typeof info.integrity !== "string") {
    throw new Error(`npm pack returned no filename/integrity for ${pkg.manifest.name}`);
  }
  return { ...pkg, tarball: join(destination, info.filename), integrity: info.integrity };
}

export function createTagBuffer() {
  const tags = new Map();
  return {
    add(pkg) {
      const tag = `${pkg.manifest.name}@${pkg.manifest.version}`;
      const entry = {
        tag,
        packageName: pkg.manifest.name,
        version: pkg.manifest.version,
      };
      if (typeof pkg.directory === "string") entry.directory = pkg.directory;
      tags.set(pkg.manifest.name, entry);
    },
    entries() {
      return [...tags.values()];
    },
    flushOne(packageName, emit = (line) => console.log(line), shouldEmit = () => true) {
      const entry = tags.get(packageName);
      if (!entry) return [];
      tags.delete(packageName);
      if (!shouldEmit(entry)) return [];
      emit(`New tag: ${entry.tag}`);
      return [entry.tag];
    },
    flush(emit = (line) => console.log(line), shouldEmit = () => true) {
      const pending = [...tags.values()];
      const emitted = [];
      for (const entry of pending) {
        emitted.push(...this.flushOne(entry.packageName, emit, shouldEmit));
      }
      return emitted;
    },
  };
}

function githubContext({ required = false, requireSha = false } = {}) {
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  const sha = process.env.GITHUB_SHA?.trim();
  const missing = [];
  if (!repository) missing.push("GITHUB_REPOSITORY");
  if (!token) missing.push("GITHUB_TOKEN");
  if (requireSha && !sha) missing.push("GITHUB_SHA");
  if (missing.length > 0) {
    if (!required) return undefined;
    throw new Error(`GitHub API context is missing: ${missing.join(", ")}`);
  }
  const [owner, name, ...extra] = repository.split("/");
  if (!owner || !name || extra.length > 0) {
    throw new Error(`GITHUB_REPOSITORY must be owner/name, got ${repository}`);
  }
  return { owner, name, repository, token, sha };
}

function githubUrl(context, path) {
  return `${githubApiBase}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}${path}`;
}

function githubHeaders(token, includeContentType = false) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "signalridge-pi-extensions-release",
    "x-github-api-version": "2022-11-28",
    ...(includeContentType ? { "content-type": "application/json" } : {}),
  };
}

async function responseDetails(response) {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

async function githubReleaseExists(tag, context = githubContext()) {
  if (!context) return undefined;
  const response = await fetch(githubUrl(context, `/releases/tags/${encodeURIComponent(tag)}`), {
    headers: githubHeaders(context.token),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed for ${tag}: HTTP ${response.status}`);
  }
  return true;
}

async function requireReleasePullRequest(currentHead) {
  const context = githubContext({ required: true });
  const response = await fetch(githubUrl(context, `/commits/${encodeURIComponent(currentHead)}/pulls`), {
    headers: githubHeaders(context.token),
  });
  if (!response.ok) {
    throw new Error(`GitHub release PR lookup failed for ${currentHead}: HTTP ${response.status}`);
  }

  let pullRequests;
  try {
    pullRequests = await response.json();
  } catch (error) {
    throw new Error(`GitHub release PR lookup returned invalid JSON: ${error}`);
  }
  const qualifying = findQualifyingReleasePullRequest(pullRequests, {
    releaseBranch: process.env.PUBLISH_RELEASE_BRANCH ?? DEFAULT_RELEASE_BRANCH,
    baseBranch: DEFAULT_RELEASE_BASE_BRANCH,
    currentRepository: context.repository,
  });
  if (!qualifying) {
    throw new Error(
      `current HEAD ${currentHead} is not associated with a merged Changesets release PR from ` +
        `${process.env.PUBLISH_RELEASE_BRANCH ?? DEFAULT_RELEASE_BRANCH} into ${DEFAULT_RELEASE_BASE_BRANCH} ` +
        `in ${context.repository}`,
    );
  }
  if (!isValidReleasePullRequestMetadata(qualifying)) {
    throw new Error(`GitHub release PR for ${currentHead} has an invalid number or head.sha`);
  }
  return qualifying;
}

export function fetchReleasePullRequestHead(pullRequest) {
  if (!isValidReleasePullRequestMetadata(pullRequest)) {
    throw new Error("GitHub release PR metadata requires a positive number and non-empty head.sha");
  }
  const ref = `refs/pull/${pullRequest.number}/head`;
  const result = runGit(["fetch", "--no-tags", "--force", "origin", ref]);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`could not fetch ${ref} from origin: ${diagnostic(result)}`);
  }
  const fetchedSha = gitText(["rev-parse", "--verify", "FETCH_HEAD^{commit}"], "could not inspect FETCH_HEAD");
  if (fetchedSha !== pullRequest.head.sha) {
    throw new Error(
      `fetched ${ref} at ${fetchedSha}, but GitHub API reported ${pullRequest.head.sha}; refusing to publish`,
    );
  }
  return fetchedSha;
}

export function buildGitHubReleasePayload({ tag, version, body, targetCommit }) {
  if (
    typeof tag !== "string" ||
    tag === "" ||
    typeof version !== "string" ||
    version === "" ||
    typeof body !== "string" ||
    body === "" ||
    typeof targetCommit !== "string" ||
    targetCommit === ""
  ) {
    throw new Error("GitHub release payload requires tag, version, body, and target commit");
  }
  return {
    tag_name: tag,
    name: tag,
    body,
    prerelease: version.includes("-"),
    target_commitish: targetCommit,
  };
}

function releaseBody(entry) {
  if (typeof entry.directory !== "string" || entry.directory.length === 0) {
    throw new Error(`cannot locate package snapshot directory for ${entry.tag}`);
  }
  const changelogPath = join(entry.directory, "CHANGELOG.md");
  let changelog;
  try {
    changelog = readFileSync(changelogPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read changelog for ${entry.tag}: ${error}`);
  }
  const section = extractChangelogSection(changelog, entry.version);
  if (!section) throw new Error(`missing changelog entry for ${entry.tag}`);
  return section;
}

async function createGitHubRelease(entry) {
  const context = githubContext({ required: true, requireSha: true });
  const exists = await githubReleaseExists(entry.tag, context);
  if (exists) {
    console.log(`release: ${entry.tag} already exists`);
    return;
  }
  const body = releaseBody(entry);
  const response = await fetch(githubUrl(context, "/releases"), {
    method: "POST",
    headers: githubHeaders(context.token, true),
    body: JSON.stringify(
      buildGitHubReleasePayload({
        tag: entry.tag,
        version: entry.version,
        body,
        targetCommit: context.sha,
      }),
    ),
  });
  if (response.ok) {
    console.log(`release: ${entry.tag}`);
    return;
  }
  if (response.status === 409 || response.status === 422) {
    const existsAfterConflict = await githubReleaseExists(entry.tag, context);
    if (existsAfterConflict) {
      console.warn(`release: ${entry.tag} was created concurrently; treating it as successful`);
      return;
    }
  }
  const details = await responseDetails(response);
  throw new Error(
    `GitHub release creation failed for ${entry.tag}: HTTP ${response.status}${details ? `: ${details}` : ""}`,
  );
}

async function flushTagBuffer(buffer) {
  const entries = buffer.entries();
  if (entries.length === 0) return [];
  if (process.env.PUBLISH_CREATE_GITHUB_RELEASES === "true") {
    const flushed = [];
    for (const entry of entries) {
      await createGitHubRelease(entry);
      flushed.push(...buffer.flushOne(entry.packageName, () => undefined));
    }
    return flushed;
  }
  const context = githubContext();
  if (!context) return buffer.flush();
  const incomplete = new Set();
  for (const entry of entries) {
    const exists = await githubReleaseExists(entry.tag, context);
    if (!exists) incomplete.add(entry.tag);
  }
  return buffer.flush(
    (line) => console.log(line),
    (entry) => incomplete.has(entry.tag),
  );
}

function publishOne(pkg, tag, cooldownMs) {
  let lastResult;
  for (let attempt = 1; attempt <= defaultRetryDelaysMs.length + 1; attempt += 1) {
    if (attempt > 1 && cooldownMs > 0) wait(cooldownMs);
    console.log(`publish: ${pkg.manifest.name}@${pkg.manifest.version} (attempt ${attempt})`);
    const result = runNpm(buildPublishArgs(pkg.tarball, tag), { cwd: root });
    writeOutput(result);
    lastResult = result;
    if (result.status === 0) return;

    // npm can have accepted the write before the client observed the response.
    // Verify the exact integrity before treating a failed publish as recovered.
    const remote = readRemoteIntegrity(pkg.manifest);
    if (remote.exists) {
      if (remote.integrity !== pkg.integrity) {
        throw new Error(
          `version mismatch after failed publish for ${pkg.manifest.name}@${pkg.manifest.version}: ` +
            `registry has ${remote.integrity ?? "no integrity"}, local tarball has ${pkg.integrity}`,
        );
      }
      console.warn(
        `publish: ${pkg.manifest.name}@${pkg.manifest.version} is already on the registry; treating the failed response as recovered`,
      );
      return;
    }

    if (!isRateLimitFailure(result) || attempt > defaultRetryDelaysMs.length) {
      throw new Error(
        `npm publish failed for ${pkg.manifest.name}@${pkg.manifest.version}: ${diagnostic(result).trim()}`,
      );
    }
    const delay = retryDelayMs(result, attempt);
    console.warn(`npm registry rate limit (429); retrying publish in ${delay}ms (attempt ${attempt + 1})`);
    wait(delay);
  }
  throw new Error(`npm publish failed: ${diagnostic(lastResult).trim()}`);
}

async function withPackageSnapshot(snapshotSha, changedDirectories, callback) {
  if (typeof snapshotSha !== "string" || snapshotSha.length === 0 || snapshotSha.trim() !== snapshotSha) {
    throw new Error("package snapshot requires a non-empty commit SHA");
  }
  const snapshotTemp = mkdtempSync(join(tmpdir(), "pi-publish-snapshot-"));
  try {
    const archivePath = join(snapshotTemp, "snapshot.tar");
    const extractedRoot = join(snapshotTemp, "root");
    mkdirSync(extractedRoot, { recursive: true });
    const archivePaths = [...changedDirectories].sort().map((directory) => snapshotPackagePath(directory));
    if (archivePaths.length > 0) {
      const archive = runGit([
        "archive",
        "--format=tar",
        `--output=${archivePath}`,
        snapshotSha,
        "--",
        ...archivePaths,
      ]);
      if (archive.error) throw archive.error;
      if (archive.status !== 0) {
        throw new Error(`could not archive package snapshot ${snapshotSha}: ${diagnostic(archive)}`);
      }
      const extracted = spawnSync("tar", ["-xf", archivePath, "-C", extractedRoot], {
        cwd: root,
        encoding: "utf8",
      });
      if (extracted.error) throw extracted.error;
      if (extracted.status !== 0) {
        throw new Error(`could not extract package snapshot: ${diagnostic(extracted)}`);
      }
    }
    return await callback(extractedRoot);
  } finally {
    rmSync(snapshotTemp, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes("--classify-release-transition")) {
    console.log((await classifyCurrentReleaseTransition()) ? "true" : "false");
    return;
  }
  const transition = await readChangedPackageDirectories();
  if (transition === undefined) {
    console.log("publish-changesets: current HEAD is not a Version Packages release transition");
    return;
  }
  const tag = validateDistTag(process.env.PUBLISH_TAG ?? "latest");
  if (process.env.PUBLISH_CREATE_GITHUB_RELEASES === "true") {
    githubContext({ required: true, requireSha: true });
  }

  const tagBuffer = createTagBuffer();
  await withPackageSnapshot(transition.snapshotSha, transition.changedDirectories, async (snapshotRoot) => {
    const snapshotPackages = readSnapshotPackages(snapshotRoot, transition.changedDirectories);
    const remoteVersions = new Map();
    for (const pkg of snapshotPackages) {
      remoteVersions.set(pkg.manifest.name, readRemoteVersions(pkg.manifest));
    }
    const { candidates, existingChanged, unbootstrapped } = selectPublishCandidates(
      snapshotPackages,
      transition.changedDirectories,
      remoteVersions,
    );

    if (unbootstrapped.length > 0) {
      throw new Error(
        `new npm package names require one-at-a-time bootstrap before Changesets publication: ${unbootstrapped.join(", ")}`,
      );
    }

    for (const pkg of existingChanged) {
      const integrity = readRemoteIntegrity(pkg.manifest);
      if (integrity.integrity === undefined) {
        throw new Error(
          `cannot safely resume ${pkg.manifest.name}@${pkg.manifest.version}: registry has no dist.integrity`,
        );
      }
      const destination = mkdtempSync(join(tmpdir(), "pi-publish-check-"));
      try {
        const packed = packPackage(pkg, destination);
        if (packed.integrity !== integrity.integrity) {
          throw new Error(
            `version mismatch for ${pkg.manifest.name}@${pkg.manifest.version}: ` +
              `registry has ${integrity.integrity}, local tarball has ${packed.integrity}`,
          );
        }
      } finally {
        rmSync(destination, { recursive: true, force: true });
      }
      console.log(`publish: ${pkg.manifest.name}@${pkg.manifest.version} already published with matching integrity`);
      tagBuffer.add(pkg);
    }

    if (candidates.length === 0) {
      console.log("publish-changesets: no unpublished versioned packages");
      await flushTagBuffer(tagBuffer);
      return;
    }

    for (const pkg of candidates) {
      assertDistTagDoesNotRegress({
        packageName: pkg.manifest.name,
        version: pkg.manifest.version,
        tag,
        remoteVersion: readRemoteDistTag(pkg.manifest, tag),
      });
    }
    const destination = mkdtempSync(join(tmpdir(), "pi-publish-changesets-"));
    try {
      const packed = orderPublishPackages(candidates).map((pkg) => packPackage(pkg, destination));
      const cooldownMs = Number.parseInt(process.env.PUBLISH_COOLDOWN_MS ?? `${DEFAULT_PUBLISH_COOLDOWN_MS}`, 10);
      if (!Number.isInteger(cooldownMs) || cooldownMs < 0) {
        throw new Error("PUBLISH_COOLDOWN_MS must be a non-negative integer");
      }
      if (process.env.PUBLISH_CREATE_GITHUB_RELEASES === "true") {
        for (const pkg of packed) {
          releaseBody({
            tag: `${pkg.manifest.name}@${pkg.manifest.version}`,
            version: pkg.manifest.version,
            directory: pkg.directory,
          });
        }
      }
      await flushTagBuffer(tagBuffer);
      let writeCount = 0;
      for (const pkg of packed) {
        if (writeCount > 0 && cooldownMs > 0) wait(cooldownMs);
        publishOne(pkg, tag, cooldownMs);
        tagBuffer.add(pkg);
        await flushTagBuffer(tagBuffer);
        writeCount += 1;
      }
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`publish-changesets: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDistTagDoesNotRegress,
  buildGitHubReleasePayload,
  buildPublishArgs,
  classifyCurrentReleaseTransition,
  createTagBuffer,
  DEFAULT_PUBLISH_COOLDOWN_MS,
  extractChangelogSection,
  findQualifyingReleasePullRequest,
  hasQualifyingReleasePullRequest,
  isQualifyingReleasePullRequest,
  isRateLimitFailure,
  isValidReleasePullRequestMetadata,
  isVersionPackagesReleaseSubject,
  orderPublishPackages,
  packageDirectoryFromPath,
  parseRetryAfterMs,
  parseVersionsOutput,
  retryDelayMs,
  selectPublishCandidates,
  selectReleaseTransition,
  snapshotPackagePath,
} from "./publish-changesets.mjs";

test("classifies authenticated current release transitions for stale-event draining", async () => {
  assert.equal(await classifyCurrentReleaseTransition(async () => undefined), false);
  assert.equal(await classifyCurrentReleaseTransition(async () => ({ releaseCommit: "abc" })), true);
});

test("parses Changesets output inputs without shell interpolation", () => {
  assert.deepEqual(parseVersionsOutput('["0.1.0", "0.2.0"]'), ["0.1.0", "0.2.0"]);
  assert.deepEqual(parseVersionsOutput('"0.3.0"'), ["0.3.0"]);
  assert.deepEqual(parseVersionsOutput(""), []);
  assert.deepEqual(packageDirectoryFromPath("packages/pi-lsp/package.json"), "pi-lsp");
  assert.equal(packageDirectoryFromPath("package.json"), undefined);
  assert.equal(packageDirectoryFromPath("packages/pi-lsp/src/package.json"), undefined);
  assert.equal(snapshotPackagePath("pi-lsp"), "packages/pi-lsp");
  assert.throws(() => snapshotPackagePath("../pi-lsp"), /invalid package directory/);
  assert.deepEqual(buildPublishArgs("/tmp/package.tgz", "latest"), [
    "publish",
    "/tmp/package.tgz",
    "--access",
    "public",
    "--tag",
    "latest",
    "--ignore-scripts",
    "--provenance",
  ]);
});

test("refuses to move an npm dist-tag backwards", () => {
  assert.doesNotThrow(() =>
    assertDistTagDoesNotRegress({
      packageName: "@signalridge/pi-demo",
      version: "1.2.3",
      tag: "latest",
      remoteVersion: "1.2.3",
    }),
  );
  assert.doesNotThrow(() =>
    assertDistTagDoesNotRegress({
      packageName: "@signalridge/pi-demo",
      version: "1.2.4",
      tag: "latest",
      remoteVersion: "1.2.3",
    }),
  );
  assert.throws(
    () =>
      assertDistTagDoesNotRegress({
        packageName: "@signalridge/pi-demo",
        version: "1.2.3",
        tag: "latest",
        remoteVersion: "1.2.4",
      }),
    /refusing to move npm dist-tag .* backwards/,
  );
});

test("extracts the exact package release section from Changesets changelogs", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [1.2.3]",
    "",
    "### Patch Changes",
    "",
    "- bracketed release note",
    "",
    "## 1.2.2",
    "",
    "- older release note",
  ].join("\n");

  assert.equal(
    extractChangelogSection(changelog, "1.2.3"),
    "## [1.2.3]\n\n### Patch Changes\n\n- bracketed release note",
  );
  assert.equal(extractChangelogSection(changelog, "1.2.2"), "## 1.2.2\n\n- older release note");
  assert.equal(extractChangelogSection(changelog, "1.2.1"), undefined);
  assert.deepEqual(
    buildGitHubReleasePayload({
      tag: "@signalridge/pi-demo@1.2.3-beta.1",
      version: "1.2.3-beta.1",
      body: "## 1.2.3-beta.1",
      targetCommit: "abc123",
    }),
    {
      tag_name: "@signalridge/pi-demo@1.2.3-beta.1",
      name: "@signalridge/pi-demo@1.2.3-beta.1",
      body: "## 1.2.3-beta.1",
      prerelease: true,
      target_commitish: "abc123",
    },
  );
});

test("selects only packages changed by the authenticated release transition", () => {
  const current = {
    workspaceDirectory: "pi-current-release",
    manifest: { name: "@signalridge/pi-current-release", version: "0.2.0" },
  };
  const overlap = {
    workspaceDirectory: "pi-overlap",
    manifest: { name: "@signalridge/pi-overlap", version: "0.3.0" },
  };
  const unbootstrapped = {
    workspaceDirectory: "pi-new",
    manifest: { name: "@signalridge/pi-new", version: "0.1.0" },
  };
  const selection = selectPublishCandidates(
    [current, overlap, unbootstrapped],
    new Set(["pi-current-release", "pi-new"]),
    new Map([
      [current.manifest.name, { exists: true, versions: new Set(["0.1.0"]) }],
      [overlap.manifest.name, { exists: true, versions: new Set(["0.2.0"]) }],
      [unbootstrapped.manifest.name, { exists: false, versions: new Set() }],
    ]),
  );

  assert.deepEqual(selection.candidates, [current]);
  assert.deepEqual(selection.existingChanged, []);
  assert.deepEqual(selection.unbootstrapped, [unbootstrapped.manifest.name]);
});

test("recognizes registry throttling, numeric/date Retry-After, and bounded fallback", () => {
  assert.equal(isRateLimitFailure({ status: 1, stderr: "E429 Too Many Requests" }), true);
  assert.equal(isRateLimitFailure({ status: 1, stderr: "E403 forbidden" }), false);
  assert.equal(parseRetryAfterMs({ status: 1, stderr: "retry-after: 1934" }), 1_934_000);
  assert.equal(
    parseRetryAfterMs({ status: 1, stderr: `retry-after: ${new Date(Date.now() + 5_000).toUTCString()}` }) > 0,
    true,
  );
  assert.equal(parseRetryAfterMs({ status: 1, stderr: "permission denied" }), undefined);
  assert.equal(retryDelayMs({ status: 1, stderr: "E429" }, 4, [100, 200]), 200);
  assert.ok(DEFAULT_PUBLISH_COOLDOWN_MS >= 10_000);
});

test("selects only the current Version Packages release transition", () => {
  assert.deepEqual(
    selectReleaseTransition({
      head: "release-head",
      headSubject: "chore(release): version packages",
      parents: ["main-parent"],
    }),
    { releaseCommit: "release-head", form: "head" },
  );
  assert.deepEqual(
    selectReleaseTransition({
      head: "merge-head",
      headSubject: "Merge pull request #42 from release",
      parents: ["main-parent", "release-parent"],
      parentSubjects: new Map([["release-parent", "chore(release): version packages (#42)"]]),
    }),
    { releaseCommit: "release-parent", form: "second-parent" },
  );
  assert.deepEqual(
    selectReleaseTransition({
      head: "squash-head",
      headSubject: "Version Packages (#42)",
      parents: ["main-parent"],
    }),
    { releaseCommit: "squash-head", form: "head" },
  );
  assert.equal(isVersionPackagesReleaseSubject("fix: ordinary push"), false);
});

test("authorizes only a merged same-repository Changesets release PR", () => {
  const currentRepository = "signalridge/pi-extensions";
  const qualifying = {
    number: 42,
    merged_at: "2026-03-01T00:00:00Z",
    head: {
      ref: "changeset-release/main",
      sha: "release-head-sha",
      repo: { full_name: currentRepository },
    },
    base: { ref: "main" },
  };
  assert.equal(isQualifyingReleasePullRequest(qualifying, { currentRepository }), true);
  assert.equal(findQualifyingReleasePullRequest([qualifying], { currentRepository }), qualifying);
  assert.equal(isValidReleasePullRequestMetadata(qualifying), true);
  assert.equal(
    hasQualifyingReleasePullRequest(
      [{ ...qualifying, head: { ...qualifying.head, ref: "feature/release" } }, qualifying],
      { currentRepository },
    ),
    true,
  );
  assert.equal(
    hasQualifyingReleasePullRequest(
      [
        { ...qualifying, merged_at: null },
        { ...qualifying, head: { ...qualifying.head, ref: "feature/release" } },
        { ...qualifying, base: { ref: "develop" } },
        { ...qualifying, head: { ...qualifying.head, repo: { full_name: "someone/fork" } } },
      ],
      { currentRepository },
    ),
    false,
  );
  assert.equal(hasQualifyingReleasePullRequest([{ ...qualifying, merged_at: "" }], { currentRepository }), false);
  assert.equal(hasQualifyingReleasePullRequest([], { currentRepository }), false);
  assert.equal(isQualifyingReleasePullRequest(qualifying, { currentRepository: "someone/fork" }), false);
  assert.equal(isValidReleasePullRequestMetadata({ ...qualifying, number: 0 }), false);
  assert.equal(isValidReleasePullRequestMetadata({ ...qualifying, number: "42" }), false);
  assert.equal(isValidReleasePullRequestMetadata({ ...qualifying, head: { ...qualifying.head, sha: "" } }), false);
  assert.equal(isValidReleasePullRequestMetadata({ ...qualifying, head: {} }), false);
  const releaseLikeTransition = selectReleaseTransition({
    head: "ordinary-release-like-head",
    headSubject: "Version Packages (manual)",
    parents: ["main-parent"],
  });
  assert.ok(releaseLikeTransition);
  assert.equal(
    hasQualifyingReleasePullRequest([{ ...qualifying, head: { ...qualifying.head, ref: "manual" } }], {
      currentRepository,
    }),
    false,
  );
});

test("does not rediscover an old historical release on an ordinary push", () => {
  assert.equal(
    selectReleaseTransition({
      head: "ordinary-head",
      headSubject: "fix: update docs",
      parents: ["ordinary-parent", "other-parent"],
      parentSubjects: new Map([
        ["ordinary-parent", "chore(release): version packages"],
        ["other-parent", "fix: unrelated branch"],
      ]),
    }),
    undefined,
  );
});

test("flushes successful package reporting independently and deduplicates a package", () => {
  const buffer = createTagBuffer();
  const packageOne = { manifest: { name: "@signalridge/pi-one", version: "1.0.0" } };
  const packageOneAgain = { manifest: { name: "@signalridge/pi-one", version: "1.0.0" } };
  const packageTwo = { manifest: { name: "@signalridge/pi-two", version: "2.0.0" } };
  const lines = [];

  buffer.add(packageOne);
  buffer.add(packageOneAgain);
  buffer.add(packageTwo);
  assert.deepEqual(
    buffer.flushOne(packageOne.manifest.name, (line) => lines.push(line)),
    ["@signalridge/pi-one@1.0.0"],
  );
  assert.deepEqual(lines, ["New tag: @signalridge/pi-one@1.0.0"]);
  assert.deepEqual(
    buffer.entries().map((entry) => entry.tag),
    ["@signalridge/pi-two@2.0.0"],
  );
  assert.deepEqual(
    buffer.flushOne(packageTwo.manifest.name, (line) => lines.push(line)),
    ["@signalridge/pi-two@2.0.0"],
  );
  assert.deepEqual(lines, ["New tag: @signalridge/pi-one@1.0.0", "New tag: @signalridge/pi-two@2.0.0"]);
  assert.deepEqual(buffer.flushOne(packageTwo.manifest.name), []);
});

test("can suppress tags whose GitHub releases already exist", () => {
  const buffer = createTagBuffer();
  buffer.add({ manifest: { name: "@signalridge/pi-one", version: "1.0.0" } });
  buffer.add({ manifest: { name: "@signalridge/pi-two", version: "2.0.0" } });
  const lines = [];

  assert.deepEqual(
    buffer.flush(
      (line) => lines.push(line),
      (entry) => entry.packageName === "@signalridge/pi-two",
    ),
    ["@signalridge/pi-two@2.0.0"],
  );
  assert.deepEqual(lines, ["New tag: @signalridge/pi-two@2.0.0"]);
});

test("orders changed packages after their changed local dependencies", () => {
  const protocol = { manifest: { name: "@signalridge/protocol" } };
  const runtime = {
    manifest: {
      name: "@signalridge/runtime",
      dependencies: { "@signalridge/protocol": "^1.0.0" },
    },
  };
  assert.deepEqual(orderPublishPackages([runtime, protocol]), [protocol, runtime]);
});

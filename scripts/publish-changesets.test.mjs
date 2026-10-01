import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDistTagDoesNotRegress,
  assertPi099RecoveryDirectories,
  assertPi099RecoveryDispatch,
  assertPi099RecoveryPullRequest,
  assertPi099RecoveryTransition,
  assertPi099TagRef,
  buildGitHubReleasePayload,
  buildPublishArgs,
  classifyCurrentReleaseTransition,
  createTagBuffer,
  DEFAULT_PUBLISH_COOLDOWN_MS,
  extractChangelogSection,
  fetchGitHubRead,
  findQualifyingReleasePullRequest,
  hasQualifyingReleasePullRequest,
  isQualifyingReleasePullRequest,
  isRateLimitFailure,
  isValidReleasePullRequestMetadata,
  isVersionPackagesReleaseSubject,
  orderPublishPackages,
  PI_099_RECOVERY,
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

test("accepts only the fixed Pi 0.99 recovery dispatch on current main", () => {
  const valid = {
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    repository: PI_099_RECOVERY.repository,
    githubSha: "current-main-sha",
    checkoutHead: "current-main-sha",
    originMain: "current-main-sha",
    directReleases: true,
    tag: "latest",
  };
  assert.doesNotThrow(() => assertPi099RecoveryDispatch(valid));
  for (const change of [{ eventName: "push" }, { ref: "refs/heads/feature" }, { repository: "someone/fork" }]) {
    assert.throws(() => assertPi099RecoveryDispatch({ ...valid, ...change }), /requires a dispatch from/);
  }
  for (const change of [{ githubSha: "different" }, { checkoutHead: "different" }, { originMain: "different" }]) {
    assert.throws(() => assertPi099RecoveryDispatch({ ...valid, ...change }), /current origin\/main checkout/);
  }
  for (const change of [{ directReleases: false }, { tag: "next" }]) {
    assert.throws(
      () => assertPi099RecoveryDispatch({ ...valid, ...change }),
      /direct GitHub releases and the latest npm tag/,
    );
  }
});

test("authenticates the reviewed merge, PR head, and exact 28-package selection", () => {
  const transition = { form: "head", releaseCommit: PI_099_RECOVERY.mergeSha };
  const parents = [PI_099_RECOVERY.parentSha];
  const pullRequest = {
    number: PI_099_RECOVERY.pullRequestNumber,
    merged_at: "2026-10-01T03:34:44Z",
    merge_commit_sha: PI_099_RECOVERY.mergeSha,
    head: {
      ref: "changeset-release/main",
      sha: PI_099_RECOVERY.headSha,
      repo: { full_name: PI_099_RECOVERY.repository },
    },
    base: { ref: "main", repo: { full_name: PI_099_RECOVERY.repository } },
  };
  assert.doesNotThrow(() => assertPi099RecoveryTransition(transition, parents));
  assert.equal(assertPi099RecoveryPullRequest(pullRequest), pullRequest);
  assert.doesNotThrow(() => assertPi099RecoveryDirectories(new Set(PI_099_RECOVERY.directories)));
  assert.throws(() => assertPi099RecoveryTransition(undefined, parents), /reviewed Version Packages transition/);
  assert.throws(
    () => assertPi099RecoveryTransition(transition, ["another-parent"]),
    /reviewed Version Packages transition/,
  );
  assert.throws(
    () => assertPi099RecoveryTransition({ ...transition, form: "second-parent" }, parents),
    /reviewed Version Packages transition/,
  );
  assert.throws(
    () => assertPi099RecoveryTransition({ ...transition, releaseCommit: "ordinary-head" }, parents),
    /reviewed Version Packages transition/,
  );
  for (const change of [
    { number: 35 },
    { merged_at: null },
    { merge_commit_sha: "another-merge" },
    { head: { ...pullRequest.head, sha: "another-head" } },
    { head: { ...pullRequest.head, ref: "feature" } },
    { head: { ...pullRequest.head, repo: { full_name: "someone/fork" } } },
    { base: { ...pullRequest.base, repo: { full_name: "someone/fork" } } },
  ]) {
    assert.throws(() => assertPi099RecoveryPullRequest({ ...pullRequest, ...change }), /merged release PR #34/);
  }
  assert.throws(
    () => assertPi099RecoveryDirectories(new Set(PI_099_RECOVERY.directories.slice(1))),
    /reviewed release transition/,
  );
  assert.throws(
    () => assertPi099RecoveryDirectories(new Set([...PI_099_RECOVERY.directories, "pi-subagents-protocol"])),
    /reviewed release transition/,
  );
});

test("accepts only Git tag refs targeting the authenticated release merge", () => {
  const tag = "@signalridge/pi-agent-guidance@1.2.4";
  const reference = { ref: `refs/tags/${tag}`, object: { type: "commit", sha: PI_099_RECOVERY.mergeSha } };
  assert.doesNotThrow(() => assertPi099TagRef(tag, reference));
  assert.throws(
    () => assertPi099TagRef(tag, { ...reference, object: { type: "commit", sha: "another-sha" } }),
    /does not point to/,
  );
  assert.throws(
    () => assertPi099TagRef(tag, { ...reference, object: { type: "tag", sha: PI_099_RECOVERY.mergeSha } }),
    /does not point to/,
  );
});

test("retries transient GitHub GET failures and preserves real HTTP outcomes", async () => {
  const url = "https://api.github.com/repos/signalridge/pi-extensions/releases/tags/test";
  const delays = [];
  const seen = [];
  const options = {
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    warn: () => {},
    retryDelaysMs: [1_000, 3_000],
    request: async (requestedUrl, requestOptions) => {
      seen.push({ requestedUrl, authorization: requestOptions.headers.authorization });
      if (seen.length === 1) throw new TypeError("fetch failed", { cause: new Error("socket reset") });
      return new Response(null, { status: 200 });
    },
  };
  const response = await fetchGitHubRead(url, { authorization: "Bearer test" }, options);
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [
    { requestedUrl: url, authorization: "Bearer test" },
    { requestedUrl: url, authorization: "Bearer test" },
  ]);
  assert.deepEqual(delays, [1_000]);

  let calls = 0;
  for (const status of [404, 401, 403]) {
    const result = await fetchGitHubRead(
      url,
      {},
      {
        request: async () => {
          calls += 1;
          return new Response(null, { status });
        },
        delay: async () => {
          throw new Error("permanent status must not be retried");
        },
        warn: () => {},
      },
    );
    assert.equal(result.status, status);
  }
  assert.equal(calls, 3);
});

test("honors bounded GitHub rate-limit and server retries without swallowing failure", async () => {
  const url = "https://api.github.com/repos/signalridge/pi-extensions/pulls/34";
  const delays = [];
  const responses = [
    new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 200 }),
  ];
  const response = await fetchGitHubRead(
    url,
    {},
    {
      request: async () => responses.shift(),
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      retryDelaysMs: [1_000, 3_000],
      warn: () => {},
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(delays, [2_000, 3_000]);

  let attempts = 0;
  await assert.rejects(
    fetchGitHubRead(
      url,
      {},
      {
        request: async () => {
          attempts += 1;
          throw new TypeError("fetch failed");
        },
        delay: async () => {},
        retryDelaysMs: [1, 2],
        warn: () => {},
      },
    ),
    /GitHub GET .* failed after 3 attempts: TypeError: fetch failed/,
  );
  assert.equal(attempts, 3);
});

test("retries headerless secondary throttling but preserves an ordinary forbidden response", async () => {
  const url = "https://api.github.com/repos/signalridge/pi-extensions/releases/tags/test";
  const delays = [];
  const responses = [
    new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "4999" },
    }),
    new Response(null, { status: 200 }),
  ];
  const recovered = await fetchGitHubRead(
    url,
    {},
    {
      request: async () => responses.shift(),
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      retryDelaysMs: [1_000],
      warn: () => {},
    },
  );
  assert.equal(recovered.status, 200);
  assert.deepEqual(delays, [30_000]);
  assert.equal(responses.length, 0);

  const denied = await fetchGitHubRead(
    url,
    {},
    {
      request: async () =>
        new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "4999" },
        }),
      delay: async () => {
        throw new Error("ordinary authorization failure must not be retried");
      },
      warn: () => {},
    },
  );
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /Resource not accessible by integration/);

  const throttledDelays = [];
  let attempts = 0;
  await assert.rejects(
    fetchGitHubRead(
      url,
      {},
      {
        request: async () => {
          attempts += 1;
          return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
            status: 403,
          });
        },
        delay: async (milliseconds) => {
          throttledDelays.push(milliseconds);
        },
        retryDelaysMs: [1, 2, 3],
        warn: () => {},
      },
    ),
    /GitHub GET .* failed after 4 attempts: HTTP 403/,
  );
  assert.equal(attempts, 4);
  assert.deepEqual(throttledDelays, [30_000, 60_000, 120_000]);
});

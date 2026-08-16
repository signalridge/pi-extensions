import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDistTagArgs,
  buildPublishArgs,
  DEFAULT_PUBLISH_COOLDOWN_MS,
  isRateLimitFailure,
  parsePublishArgs,
  parsePublishCooldownMs,
  reconcileDistTag,
  reconcileRelease,
  requireSinglePackageSelection,
  runWithRateLimitRetry,
  validateDistTag,
  validatePublishableIdentity,
} from "./publish-packages.mjs";

test("accepts safe tags and constructs argv without shell interpolation", () => {
  assert.equal(validateDistTag("latest"), "latest");
  assert.equal(validateDistTag("rc-2026.03"), "rc-2026.03");
  assert.deepEqual(buildPublishArgs("/tmp/package.tgz", "rc-2026.03"), [
    "publish",
    "/tmp/package.tgz",
    "--access",
    "public",
    "--tag",
    "rc-2026.03",
    "--ignore-scripts",
  ]);
});

test("rejects unsafe, reserved, whitespace, and version-like tags", () => {
  for (const tag of ["", " ", "bad tag", "bad/tag", "--", ".", "1", "1.2", "1.2.3", "v1.2.3", "a;b"]) {
    assert.throws(() => validateDistTag(tag), /npm dist-tag/);
  }
  assert.throws(() => validateDistTag("x".repeat(129)), /at most/);
});

test("requires canonical pi-* package identities before publishing", () => {
  assert.equal(validatePublishableIdentity({ name: "@signalridge/pi-demo" }).name, "@signalridge/pi-demo");
  for (const name of ["@signalridge/demo", "@other/pi-demo", "pi-demo", "@signalridge/pi-"]) {
    assert.throws(() => validatePublishableIdentity({ name }), /@signalridge\/pi-\* package name/);
  }
});

test("selects experimental packages from the typed workflow input or environment", () => {
  assert.equal(
    parsePublishArgs([], { PUBLISH_INCLUDE_EXPERIMENTAL: "true", PUBLISH_TAG: "beta" }).includeExperimental,
    true,
  );
  assert.equal(
    parsePublishArgs([], { PUBLISH_INCLUDE_EXPERIMENTAL: "false", PUBLISH_TAG: "latest" }).includeExperimental,
    false,
  );
  assert.equal(
    parsePublishArgs(["--include-experimental"], { PUBLISH_INCLUDE_EXPERIMENTAL: "false" }).includeExperimental,
    true,
  );
  assert.equal(parsePublishArgs(["--tag", "next"], {}).tag, "next");
  assert.throws(() => parsePublishArgs([], { PUBLISH_INCLUDE_EXPERIMENTAL: "yes" }), /PUBLISH_INCLUDE_EXPERIMENTAL/);
});

test("bootstrap mode requires one explicit package selection", () => {
  assert.throws(() => parsePublishArgs(["--bootstrap"], {}), /exactly one explicit package selection/);
  assert.throws(
    () => parsePublishArgs(["--bootstrap", "--packages=pi-one,pi-two"], {}),
    /exactly one explicit package selection/,
  );
  assert.equal(requireSinglePackageSelection(["--package=pi-one"], "bootstrap"), "pi-one");
});

test("retries rate-limited npm commands a bounded number of times", () => {
  const attempts = [];
  const delays = [];
  const result = runWithRateLimitRetry(
    "npm",
    ["publish"],
    {},
    {
      execute: () => {
        attempts.push(attempts.length + 1);
        return attempts.length < 3 ? { status: 1, stderr: "npm error E429" } : { status: 0 };
      },
      sleep: (delay) => delays.push(delay),
      maxAttempts: 4,
      delays: [100, 200, 300],
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(isRateLimitFailure({ status: 1, stderr: "Too Many Requests (429)" }), true);
  assert.equal(isRateLimitFailure({ status: 1, stderr: "permission denied" }), false);
});

test("uses a conservative inter-package cooldown with an explicit override", () => {
  assert.ok(DEFAULT_PUBLISH_COOLDOWN_MS >= 10_000);
  assert.equal(parsePublishCooldownMs("1234"), 1234);
  assert.throws(() => parsePublishCooldownMs("-1"), /PUBLISH_COOLDOWN_MS/);
});

test("partial-release resume accepts matching existing versions and rejects unsafe mismatches", () => {
  const manifest = { name: "@signalridge/example", version: "1.2.3" };
  assert.equal(reconcileRelease(manifest, "sha512-same", { packageExists: true, exists: false }).existing, false);
  assert.equal(reconcileRelease(manifest, "sha512-same", { exists: true, integrity: "sha512-same" }).existing, true);
  assert.throws(
    () => reconcileRelease(manifest, "sha512-local", { exists: true, integrity: "sha512-other" }),
    /version mismatch/,
  );
  assert.throws(() => reconcileRelease(manifest, "sha512-local", { exists: true }), /cannot safely resume/);
});

test("normal recovery rejects unbootstrapped package names while bootstrap can publish one", () => {
  const manifest = { name: "@signalridge/new-package", version: "1.2.3" };
  const remote = { packageExists: false, exists: false };

  assert.throws(
    () => reconcileRelease(manifest, "sha512-local", remote),
    /normal\/recovery mode refuses.*bootstrap exactly one package with release:publish:token or release:publish:bootstrap/,
  );
  assert.equal(reconcileRelease(manifest, "sha512-local", remote, { bootstrap: true }).existing, false);
});

test("repairs a missing or wrong requested dist-tag with safe argv", () => {
  const manifest = { name: "@signalridge/example", version: "1.2.3" };
  assert.deepEqual(buildDistTagArgs(manifest, "next"), ["dist-tag", "add", "@signalridge/example@1.2.3", "next"]);
  assert.deepEqual(reconcileDistTag(manifest, "next", { exists: false }), { action: "publish", tag: "next" });
  assert.deepEqual(reconcileDistTag(manifest, "next", { exists: true, distTags: { next: "1.2.3" } }), {
    action: "none",
    tag: "next",
  });
  assert.deepEqual(reconcileDistTag(manifest, "next", { exists: true, distTags: { next: "1.2.2" } }), {
    action: "repair",
    tag: "next",
    args: ["dist-tag", "add", "@signalridge/example@1.2.3", "next"],
  });
});

test("refuses to move a selected tag backward across prerelease ordering", () => {
  assert.throws(
    () =>
      reconcileDistTag({ name: "@signalridge/example", version: "1.0.1" }, "next", {
        exists: true,
        distTags: { next: "1.1.0-signalridge.1" },
      }),
    /refusing to move npm dist-tag .* backwards from 1.1.0-signalridge\.1 to 1.0.1/,
  );
});

test("repairs a selected tag when the manifest version is newer", () => {
  assert.deepEqual(
    reconcileDistTag({ name: "@signalridge/example", version: "1.1.0" }, "next", {
      exists: true,
      distTags: { next: "1.0.1" },
    }),
    {
      action: "repair",
      tag: "next",
      args: ["dist-tag", "add", "@signalridge/example@1.1.0", "next"],
    },
  );
});

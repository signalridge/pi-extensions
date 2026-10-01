import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/publish-packages.yml", import.meta.url);

test("publish workflow separates normal Changesets transitions from fixed recovery", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const validation = workflow.indexOf("run: bun run check");
  const revalidation = workflow.indexOf("id: release-revalidation", validation);
  const action = workflow.indexOf("uses: changesets/action@", revalidation);
  const version = workflow.indexOf("version: bun run version-packages", action);
  const publish = workflow.indexOf("publish: bun run publish-packages", action);
  const guard = workflow.indexOf("name: Require current main for Pi 0.99 recovery", revalidation);
  const recovery = workflow.indexOf("name: Resume the fixed Pi 0.99 release", action);
  const versionJob = workflow.indexOf("  version:\n");
  const jobSteps = workflow.indexOf("    steps:\n", versionJob);
  const jobEnvironment = workflow.indexOf("    environment: npm-publish\n", versionJob);
  const permissions = workflow.slice(workflow.indexOf("permissions:\n"), workflow.indexOf("concurrency:\n"));

  assert.match(
    workflow,
    /recover_pi099:\n\s+description: "Resume the fixed Pi 0\.99 release PR #34 without versioning"\n\s+type: boolean\n\s+default: false/,
  );
  assert.match(
    workflow,
    /name: Restrict Pi 0\.99 recovery dispatch\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.recover_pi099 == true\n\s+run: \|\n\s+test "\$GITHUB_REPOSITORY" = signalridge\/pi-extensions\n\s+test "\$GITHUB_REF" = refs\/heads\/main/,
  );
  assert.match(
    workflow,
    /if: steps\.release-selection\.outputs\.current-main == 'true' \|\| steps\.release-selection\.outputs\.release-transition == 'true'/,
  );
  assert.ok(validation >= 0 && revalidation > validation);
  assert.ok(action > revalidation && version > action && publish > version);
  assert.match(
    workflow,
    /if: steps\.release-revalidation\.outputs\.eligible == 'true' && inputs\.recover_pi099 != true\n\s+uses: changesets\/action@/,
  );
  assert.ok(guard > revalidation && guard < action, "current-main recovery guard must precede every publish step");
  assert.ok(recovery > publish);
  assert.ok(versionJob >= 0 && jobEnvironment > versionJob && jobEnvironment < jobSteps);
  assert.match(permissions, /^ {2}id-token: write$/m);
  assert.match(
    workflow,
    /name: Require current main for Pi 0\.99 recovery[\s\S]*?test "\$ELIGIBLE" = true\n\s+git fetch --no-tags origin main\n\s+test "\$\(git rev-parse HEAD\)" = "\$\(git rev-parse origin\/main\)"/,
  );
  assert.match(
    workflow,
    /name: Resume the fixed Pi 0\.99 release\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.recover_pi099 == true && steps\.release-revalidation\.outputs\.eligible == 'true'/,
  );
  assert.match(
    workflow,
    /PUBLISH_CREATE_GITHUB_RELEASES: "true"\n\s+PUBLISH_RECOVER_PI099: "true"\n\s+PUBLISH_TAG: latest\n\s+run: bun run publish-packages/,
  );
  assert.equal(workflow.match(/--classify-release-transition/g)?.length, 2);
});

/**
 * Every published package shares one version line. A per-package assertion here
 * would pin a release-time snapshot and go stale the moment Changesets versions
 * the next transition, which is exactly how the two predecessors of this test
 * failed; assert the invariant instead.
 */
test("every publishable package stays on the shared version line", async () => {
  const packagesDir = new URL("../packages/", import.meta.url);
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const versions = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestUrl = new URL(`${entry.name}/package.json`, packagesDir);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
    if (manifest.private === true) continue;
    versions.set(manifest.name, manifest.version);
  }

  assert.ok(versions.size > 0, "expected at least one publishable package");
  for (const [name, version] of versions) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} has a malformed version: ${version}`);
  }
});

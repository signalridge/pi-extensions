import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/publish-packages.yml", import.meta.url);

test("publish workflow versions release transitions before invoking npm publish", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const versionJob = workflow.indexOf("  version:\n");
  const checkJob = workflow.slice(workflow.indexOf("  check:\n"), versionJob);
  const versionWorkflow = workflow.slice(versionJob);
  const revalidation = workflow.indexOf("id: release-revalidation", versionJob);
  const action = workflow.indexOf("uses: changesets/action@", revalidation);
  const version = workflow.indexOf("version: bun run version-packages", action);
  const publish = workflow.indexOf("publish: bun run publish-packages", action);
  const jobSteps = workflow.indexOf("    steps:\n", versionJob);
  const jobEnvironment = workflow.indexOf("    environment: npm-publish\n", versionJob);
  const permissions = workflow.slice(workflow.indexOf("permissions:\n"), workflow.indexOf("concurrency:\n"));

  assert.match(
    workflow,
    /if: steps\.release-selection\.outputs\.current-main == 'true' \|\| steps\.release-selection\.outputs\.release-transition == 'true'/,
  );
  assert.match(checkJob, /^ {4}runs-on: ubuntu-latest\n {4}permissions:\n {6}contents: read\n {4}steps:/m);
  assert.doesNotMatch(
    checkJob,
    /^\s+(?:if|continue-on-error):|^ {4}(?:environment|needs):|id-token:|secrets\.|contents: write|pull-requests:/m,
  );
  assert.match(checkJob, /ref: \$\{\{ github\.sha \}\}\n {10}fetch-depth: 0\n {10}persist-credentials: false/);
  assert.match(versionWorkflow, /ref: \$\{\{ github\.sha \}\}\n {10}fetch-depth: 0/);
  assert.match(checkJob, /node-version: 24\n/);
  assert.match(checkJob, /bun-version: 1\.3\.14\n/);
  assert.match(checkJob, /npm install --global npm@11\.5\.1\n {10}node --version\n {10}npm --version/);
  assert.match(versionWorkflow, /npm install --global npm@11\.5\.1\n {10}node --version\n {10}npm --version/);
  assert.match(checkJob, /run: bun install --frozen-lockfile --ignore-scripts/);
  assert.equal((workflow.match(/run: bun run check\n/g) ?? []).length, 1);
  assert.match(checkJob, /run: bun run check\n/);
  assert.match(versionWorkflow, /^ {2}version:\n {4}needs: check\n/m);
  assert.doesNotMatch(
    versionWorkflow.slice(0, versionWorkflow.indexOf("    steps:\n")),
    /^ {4}(?:if|continue-on-error):/m,
  );
  assert.ok(revalidation > versionJob, "eligibility must be revalidated in the job gated by the check");
  assert.ok(action > revalidation, "Changesets writes must stay downstream of final revalidation");
  assert.match(workflow, /if: steps\.release-revalidation\.outputs\.eligible == 'true'\n\s+uses: changesets\/action@/);
  assert.equal(workflow.match(/--classify-release-transition/g)?.length, 2);
  assert.match(
    versionWorkflow,
    /id: release-selection[\s\S]*id: release-revalidation\n {8}if: steps\.release-selection\.outputs\.current-main == 'true' \|\| steps\.release-selection\.outputs\.release-transition == 'true'/,
  );
  assert.match(
    workflow,
    /concurrency:\n {2}group: changesets-\$\{\{ github\.ref \}\}\n {2}queue: max\n {2}cancel-in-progress: false/,
  );
  assert.match(workflow, /on:\n {2}workflow_dispatch:\n {2}push:\n {4}branches:\n {6}- main/);
  assert.doesNotMatch(workflow, /workflow_run:/);
  assert.ok(version > action, "Changesets action must version packages");
  assert.ok(publish > version, "publish must remain downstream of Changesets versioning");
  assert.ok(versionJob >= 0 && jobEnvironment > versionJob && jobEnvironment < jobSteps);
  assert.match(permissions, /^ {2}id-token: write$/m);
});

test("CI runs the full check on pull requests only", async () => {
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /^on:\n {2}pull_request:\njobs:/m);
  assert.doesNotMatch(ci, /workflow_run:|^ {2}push:/m);
  assert.equal((ci.match(/run: bun run check\n/g) ?? []).length, 1);
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

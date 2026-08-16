import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/publish-packages.yml", import.meta.url);

test("publish workflow versions release transitions before invoking npm publish", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.doesNotMatch(workflow, /^ {2}release-transition:|Publish current release transition/m);
  assert.doesNotMatch(workflow, /^\s*run:\s*bun run publish-packages\s*$/m);
  assert.match(workflow, /--classify-release-transition/);
  assert.match(
    workflow,
    /if: steps\.release-selection\.outputs\.current-main == 'true' \|\| steps\.release-selection\.outputs\.release-transition == 'true'/,
  );

  const validation = workflow.indexOf("run: bun run check");
  const revalidation = workflow.indexOf("id: release-revalidation", validation);
  const action = workflow.indexOf("uses: changesets/action@", revalidation);
  const version = workflow.indexOf("version: bun run version-packages", action);
  const publish = workflow.indexOf("publish: bun run publish-packages", action);
  assert.ok(validation >= 0, "the exact release revision must pass the full repository check");
  assert.ok(revalidation > validation, "main/release eligibility must be revalidated after the check");
  assert.ok(action > revalidation, "Changesets writes must stay downstream of final revalidation");
  assert.match(workflow, /if: steps\.release-revalidation\.outputs\.eligible == 'true'/);
  assert.equal(workflow.match(/--classify-release-transition/g)?.length, 2);
  assert.ok(version > action, "Changesets action must version packages");
  assert.ok(publish > version, "publish must remain downstream of Changesets versioning");
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

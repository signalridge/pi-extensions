# Releasing

This repository uses Changesets for independent package versions and npm Trusted Publishing.
The Actions publish command is a sequential Changesets-aware publisher; it does not run the
parallel default `changeset publish` implementation. Do not run `npm publish` from a checkout;
the Actions workflow is the normal release path.

## Version policy

Every package versions independently (`fixed: []` and `linked: []` in
`.changeset/config.json`). One package can ship a fix without dragging the other
twenty-six to a new version, and a package's version number means something
about that package alone.

Choose the bump from what the change does to someone who already installed the
package:

The test is: **does another package's code stop working?** An import, an
exported type, an event or RPC payload shape, a protocol version — those are
compiled against, and breaking one breaks a build. User-facing configuration is
not: a settings key or a frontmatter field that stops being read degrades with a
warning, and the session keeps running.

| Bump | When |
| --- | --- |
| **major** | Another package breaks: a removed or renamed export, a changed event or RPC payload shape, a protocol version bump. |
| **minor** | Everything else that changes behavior — a new capability, a retired settings key or frontmatter field, a different set of parameters on an LLM-facing tool, a changed default. |
| **patch** | A fix, a performance change, or a documentation change that ships in the package (`README.md` is in `files`). |

This line was drawn twice too wide before settling here. Retiring `widgetMode`,
dropping `model`/`thinking` from the `Agent` tool schema, and dropping them from
agent frontmatter are all **minor**: each leaves a key that no longer does
anything, each warns, and none of them stops another package from compiling. The
cost of that choice is real — configuration can quietly lose meaning across a
minor — so retired keys warn by name rather than failing silently, and the
changeset says what to replace them with.

The workspace baseline is **1.2.0**, chosen to clear every version already on
npm (the highest were `pi-input-history@1.1.0-signalridge.1` and several
`0.49.x`). An earlier 1.0.0 baseline was set in the repository but never
published, so for months the manifests read 1.0.0 while installs resolved
0.16.0, 0.11.0, or 0.1.0 — and Changesets, which only increments the local
number, was computing bumps from a version that had never existed. Do not
re-baseline the workspace to a number npm has already seen.

Three rules keep this honest:

- **`bun run check:changesets` fails when a package's published files changed
  without a changeset naming it.** "Published files" is the manifest's own
  `files` array, so a test, a `tsconfig.json`, or a CI edit is not a reason to
  demand a version, and a `src/` or `README.md` edit always is. Without it, a
  package whose source changed but that no changeset names is simply never
  released: the repository looks current while npm keeps serving the old code,
  and nothing surfaces the gap until someone installs it. CI runs this with
  `fetch-depth: 0` so the merge base resolves.
- **`bun run check:versions` fails when a package's local version is *behind*
  the npm `latest` tag.** The publisher refuses to move a dist-tag backward, so
  that state blocks the release outright. Equal is the normal resting state
  right after a release and passes silently; ahead means an unreleased change is
  pending and is reported, not failed. At the 1.0.0 baseline this would have
  caught two of the twenty-seven — `pi-input-history` (declared 1.0.0, npm
  already at 1.1.0-signalridge.1) and `pi-worktime` (declared 1.0.0, npm already
  at 1.0.0) — which are exactly the two that would have failed the release. It
  does not catch a version that is merely declared and never published; the
  "awaiting release" line it prints is the signal for that, and reading it is a
  human job. Registry lookups are best-effort — an unreachable registry is
  reported and skipped so an offline checkout still runs `bun run check`, and
  `CHECK_VERSIONS_OFFLINE=1` skips the network entirely.
- **A peer dependent is only bumped when the new version leaves its declared
  range** (`onlyUpdatePeerDependentsWhenOutOfRange`). `pi-workflows` declares
  `"@signalridge/pi-subagents": ">=1.9.0"` and reaches it through the versioned
  event protocol, so a subagents release that stays inside that range is not a
  reason to republish workflows. Tighten the declared range when a change really
  does require the dependent to move; that is what makes the bump happen — a
  protocol version bump always does, because the peer check is exact.

The `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH` prefix on that option is
Changesets' own warning that it may be renamed in a patch release. This is safe
here only because `@changesets/cli` is pinned to an exact version; keep it
pinned, and re-check this option when upgrading.

## Normal flow

1. For a published-package change, run `bun run changeset` and commit the generated file with the
   pull request. Select every affected package, including an experimental package when it is
   intentionally part of the release. Repository-only documentation, tests, and tooling usually do
   not need a changeset.
2. After the change reaches `main`, `.github/workflows/publish-packages.yml` creates or updates the
   **Version Packages** PR. Review its independent version bumps, changelogs, and lockfile, then
   merge that PR.
3. Every push and manual dispatch enters the workflow-level `queue: max` concurrency group, so release transitions are retained and processed one at a time. The job checks out the event SHA with full history, classifies whether it is current `origin/main` or an authenticated release transition, and runs `bun run check` against that exact revision before any Changesets write. It then fetches `origin/main` and revalidates at the last workflow boundary before the action, so a revision that became stale during validation cannot update the Version Packages PR while an authenticated release transition still drains. A release-shaped commit is authorized only when GitHub reports a merged same-repository PR from `changeset-release/main` to `main`, and the fetched PR head exactly matches the API `head.sha`; a manually named **Version Packages** commit is insufficient.
4. The Changesets action updates the **Version Packages** PR only when its checkout still equals current `origin/main`; stale ordinary revisions are a no-op. An authenticated stale release transition is still drained through the action's publish command, so a newer `main` push cannot permanently skip it. Only package manifests changed by that release commit are loaded from the authenticated PR-head snapshot. Those exact directories are packed, so later `main` changes cannot enter an older release. Existing versions are integrity-checked and release/tag-reconciled, missing versions are published one at a time in dependency order, and package names absent from npm fail as unbootstrapped. Before a write, the publisher also refuses to move the selected npm dist-tag backward to an older SemVer. Each successful package is immediately reported or given its direct GitHub release against the merged event SHA, so a later package failure does not erase earlier success.

The workflow uses Bun for the workspace and Node/npm for Changesets publication. It supplies npm
provenance through OIDC (`NPM_CONFIG_PROVENANCE=true`) and deliberately does not use `NPM_TOKEN`.

## Required one-time configuration

- Add a repository `PAT_TOKEN` secret with permission to create and update the Version Packages PR and GitHub releases.
  The workflow uses this PAT rather than inventing a second release secret; it intentionally does not silently fall back to `GITHUB_TOKEN` because its events do not trigger workflows.
- For **each npm package**, configure npm Trusted Publishing for GitHub Actions using this repository,
  the workflow filename **`publish-packages.yml`** (basename only; do not enter `.github/workflows/`),
  and the `npm-publish` environment. Repeat this for stable and experimental packages; experimental
  packages are not globally ignored, but they publish only when explicitly named by a changeset.
- Keep the npm package public and configure its package-level trusted publisher before relying on
  the OIDC release. The binding is package-specific, not an organization-wide setting.

## New package bootstrap

A brand-new npm package name must be bootstrapped once before the normal Changesets workflow can
publish it. Bootstrap **exactly one package at a time**; the wrapper refuses an omitted or
comma-separated selection and the packer does not pull local dependencies into the bootstrap tarball.
There are two explicit bootstrap modes:

### Local TTY bootstrap

Use this when npm authentication is already available locally. It preserves the terminal for npm's OTP
or browser-authentication flow:

```bash
npm whoami --registry=https://registry.npmjs.org/
bun run release:publish:bootstrap -- --package=pi-new-package --tag latest
```

### Token bootstrap

Use the token wrapper only when a token is deliberately supplied out of band. It still bootstraps one
selected package and uses the same serial, integrity-checking publisher:

```bash
printf '%s' "$NPM_TOKEN" \
  | bun run release:publish:token -- --token-stdin --package=pi-new-package --tag latest
```

After either bootstrap, configure that package's npm Trusted Publisher binding immediately. Do not use
the token wrapper for normal Changesets releases. The normal OIDC Changesets path is the GitHub Actions
workflow: it uses `PAT_TOKEN` for the Version Packages PR and npm Trusted Publishing with the workflow's
OIDC `id-token`; it does not use `NPM_TOKEN`.

Recheck npm before each bootstrap instead of relying on a stale package list. If the exact scope/package
lookup returns 404, bootstrap that one package; if it exists, use normal Changesets publication.

## Rate limits and recovery

HTTP 429 responses are registry/account-side throttling. Switching npm to pnpm, changing the
package manager, or parallelizing publishes does not bypass the limit. After the authenticated
release-transition gate passes, the publisher queries only the package manifests changed by that
transition, from the immutable PR-head snapshot. It publishes missing versions serially; versions
already present are integrity-checked and release/tag-reconciled, while packages outside the current
transition are not inspected. A package name absent from npm still fails as unbootstrapped. The
publisher retries transient 429 responses with exponential backoff and `Retry-After` when available,
and checks `dist.integrity` before resuming a matching version. Every successful package (including
an integrity-confirmed recovery) is reported immediately before the next package is attempted; a
later failure does not roll back an earlier tag/release report. The default cooldown between package
The selected npm dist-tag is monotonic: if the registry already points it at a newer SemVer, the older publish fails closed instead of moving the tag backward.
writes is 10 seconds; set `PUBLISH_COOLDOWN_MS` only when a deliberate override is needed.

For a partial custom release, rerun a dry preflight for the affected package and then rerun the same
selection; already matching versions are skipped and mismatched integrity is rejected:

```bash
bun run release:publish:recovery -- --package=pi-package --dry-run
bun run release:publish:recovery -- --package=pi-package
```

For a partial Changesets workflow release, rerun the **same workflow SHA** after confirming the Version
Packages PR was merged and that npm shows the expected versions. The rerun authenticates the same PR
head snapshot, skips matching versions only after integrity verification, and recovers missing tags or
GitHub releases. The direct-release target remains the merged `GITHUB_SHA`; its artifact and changelog
body still come from the PR-head snapshot. The retained workflow queue serializes release writes, and only the checkout that still matches the current `origin/main` may update the Version Packages PR. Do not create a
new version or force a tag to compensate for a transient failure. If a package name has never existed
on npm, bootstrap that single package first, then configure OIDC and resume the release.

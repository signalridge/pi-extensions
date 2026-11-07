# Releasing

This repository uses Changesets for independent package versions and npm Trusted Publishing.
The Actions publish command is a sequential Changesets-aware publisher; it does not run the
parallel default `changeset publish` implementation. Do not run `npm publish` from a checkout;
the Actions workflow is the normal release path.

## Version policy

Every package versions independently (`fixed: []` and `linked: []` in
`.changeset/config.json`). One package can ship a fix without changing unrelated
packages' versions.

Choose the bump by asking **does another package's code stop working?** Compiled exports, event/RPC shapes and protocols qualify; retiring user settings/frontmatter instead degrades with a named warning while the session keeps running.

| Bump | When |
| --- | --- |
| **major** | Another package breaks: a removed or renamed export, a changed event or RPC payload shape, a protocol version bump. |
| **minor** | Everything else that changes behavior — a new capability, a retired settings key or frontmatter field, a different set of parameters on an LLM-facing tool, a changed default. |
| **patch** | A fix, a performance change, or a documentation change that ships in the package (`README.md` is in `files`). |

Retired settings and frontmatter fields warn by name rather than silently losing
meaning; their changeset documents the replacement. Such retirement is minor
unless another package's compiled contract breaks.

The published workspace baseline is **1.2.0**. Never re-baseline to a number npm
has already seen, and never let a local package version fall behind its npm
`latest` tag.

Three rules keep this honest:

- **`bun run check:changesets` fails when a package's published files changed
  without a changeset naming it.** "Published files" is the manifest's own
  `files` array, so a test, a `tsconfig.json`, or a CI edit is not a reason to
  demand a version, and a `src/` or `README.md` edit always is. CI uses `fetch-depth: 0` so the merge base resolves.
- **`bun run check:versions` fails when a package's local version is *behind*
  the npm `latest` tag.** The publisher refuses to move a dist-tag backward, so
  that state blocks the release outright. Equal is the normal resting state
  right after a release and passes silently; ahead means an unreleased change is
  pending and is reported, not failed. An ahead version does not prove
  publication; inspect its "awaiting release" status separately. Registry
  lookups are best-effort — an unreachable registry is
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
3. PR CI runs the full check on pull requests. For each main push or manual dispatch, the publish workflow enters workflow-level `queue: max`, retaining events serially. Its read-only `check` job checks out that event's exact SHA with full history and runs `bun run check` once, even for stale ordinary events. The `version` job checks out the same SHA and cannot run unless `check` succeeds. A final fetch/revalidation permits Version Packages PR updates only from current `origin/main`; stale ordinary revisions do nothing. This removes the duplicate full check previously run by main-push CI and the publish workflow, without reusing PR results or checks from another revision. Queueing and validation of stale events can delay later releases; no wall-time reduction is assumed.
4. Authenticated stale release transitions still drain. Authentication requires GitHub's merged same-repository `changeset-release/main` → `main` PR and a fetched head exactly matching API `head.sha`, not merely a **Version Packages** commit title. Only manifests changed by that release commit and exact directories from its immutable authenticated PR-head snapshot are packed. Existing versions require matching integrity and release/tag reconciliation; missing versions publish serially in dependency order. Missing npm names fail as unbootstrapped, and dist-tags never move backward. Each success is immediately reported or given a direct GitHub release against the merged event SHA, surviving later failures.

The default check name for PR branch protection remains `check` from the CI workflow; the publish workflow also has a `check` job for push/manual events. Review any existing branch-protection or ruleset requirements when changing workflows; push validation is no longer a separate CI workflow run.

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
the token wrapper for normal Changesets releases; [one-time configuration](#required-one-time-configuration) separates PAT and OIDC responsibilities.

Recheck npm before each bootstrap instead of relying on a stale package list. If the exact scope/package
lookup returns 404, bootstrap that one package; if it exists, use normal Changesets publication.

## Rate limits and recovery

HTTP 429 responses are registry/account-side throttling. Switching npm to pnpm, changing the
package manager, or parallelizing publishes does not bypass the limit. Recovery retains [normal-flow selection, immutable-snapshot, serial-write, integrity and tag-safety rules](#normal-flow); packages outside the transition are not inspected. Existing npm dist-tags are not rewritten by workflow recovery and must be verified afterward. Transient 429s retry with exponential backoff and `Retry-After`; matching versions require `dist.integrity`, and each success is reported before the next package. The default between-write cooldown is 10 seconds; `PUBLISH_COOLDOWN_MS` is a deliberate override.

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
body still come from the PR-head snapshot. Do not create a new version or force a tag to compensate for a transient failure. Never-published names need [single-package bootstrap](#new-package-bootstrap) and OIDC configuration before resuming.

A rerun always executes the publisher from that original SHA, so a publisher fix merged later cannot
reach it. Rerun only while `main` still points at the release commit: the Changesets action creates
missing tags against the current `main`, and a later commit there would tag the wrong revision. GitHub
API reads in the publisher retry transport failures, 5xx responses, and rate limits (including
secondary limits) with bounded backoff, so a transient GitHub outage no longer aborts a release midway.

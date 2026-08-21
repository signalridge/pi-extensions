# signalridge Pi extensions

This is a private tooling monorepo. Every directory under `packages/` is an
independently publishable npm package; the private root is never published and
has no Pi resource manifest.

## Install

After publication, install packages individually:

```bash
pi install npm:@signalridge/pi-subagents
pi install npm:@signalridge/pi-workflows
pi install npm:@signalridge/pi-lsp
pi install npm:@signalridge/pi-ask-user-question
```

The package's own `pi.extensions` manifest controls what Pi loads. Install any
one package from a single source — an npm copy alongside a local checkout of the
same package loads both, and the duplicate registers its tools twice.

## Package inventory

Stable packages:

- `pi-subagents`, `pi-workflows`, `pi-goal`, `pi-plan-mode`, `pi-lsp`,
  `pi-github-pr`, `pi-stamp`, and `pi-btw`
- `pi-statusline`, `pi-input-history`, `pi-input-prefix`, `pi-welcome`,
  `pi-files-widget`, `pi-agent-guidance`, `pi-code-actions`,
  `pi-ask-user-question`, `pi-session-recap`, `pi-usage-extension`, `pi-ralph-wiggum`, and
  `pi-tab-status`
- `pi-herdr-state` and `pi-gpt-fast`

Shared library:

- `pi-ui` provides the consistent border adapter used by extension-owned custom dialogs; it is not a Pi resource by itself.
- `pi-worktree` and `pi-worktime` are publishable and opt-in: install them
  deliberately rather than as part of a default set. `pi-worktree` in
  particular needs a project that allows git worktrees.

Experimental packages are opt-in and marked `piExtension.lifecycle:
experimental`, which keeps them out of a release unless a changeset names them:
`pi-recall`, `pi-codex-compact`, and `pi-analytics`.

## Managed boundaries

`pi-workflows` submits typed managed-spawn requests through `pi.events`; it
does not import subagent source or read the subagent settings file. The
subagent package remains responsible for models, tools, concurrency, queueing,
turn limits, isolation, transcripts, and lifecycle state.

## Development and release

```bash
bun install --frozen-lockfile
bun run format
bun run lint
bun run typecheck
bun run test
bun run check
```

Every package owns `lint`, `typecheck`, `test`, `format`, and `check` scripts. For a published-package
change, create a changeset and inspect pending release intent:

```bash
bun run changeset
bun run changeset:status
```

The Actions workflow creates a Version Packages PR after changes reach `main`; merge that PR to
publish only the changed packages. It uses npm Trusted Publishing/OIDC. See
[`docs/releasing.md`](docs/releasing.md) for setup, bootstrap, rate-limit, and recovery guidance.

The existing custom packer and integrity-safe publisher remain available for bootstrap/recovery, not
normal Changesets releases:

```bash
bun run release:pack -- --package=pi-lsp
bun run release:publish:recovery -- --package=pi-lsp --dry-run
printf '%s' "$NPM_TOKEN" | bun run release:publish:token -- --token-stdin --package=pi-new-package --tag latest
```

Bootstrap and token mode require exactly one selected package. Experimental packages are packed or
published only when intentionally selected; Changesets likewise releases them only when a changeset
names them. See [`LEGAL-NOTICES.md`](LEGAL-NOTICES.md) for retained license handling and local
maintenance notes.

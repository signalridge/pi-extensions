# Repository guidance

This repository is a Pi package monorepo owned by signalridge.

## Boundaries

- Each extension lives in `packages/<name>` and must be independently understandable.
- Do not import source from another extension package. Share only intentionally extracted libraries.
- The root package is private tooling only and must not declare a Pi manifest; each package manifest is independently publishable and authoritative.
- Experimental packages must declare `piExtension.lifecycle: experimental` and are publishable only by explicit opt-in; they are not enabled by default.
- Extension runtime configuration belongs to the extension or to Pi; never duplicate another extension's settings schema.
- Keep entrypoints thin. Put domain logic in named modules once an extension grows beyond one file.

## Forks

- `packages/pi-subagents` is derived from `tintinweb/pi-subagents`.
- `packages/pi-analytics` is derived from `narumiruna/pi-extensions`.
- `packages/pi-statusline` is derived from `narumiruna/pi-extensions`.
- `packages/pi-worktree` is derived from `narumiruna/pi-extensions`.
- `packages/pi-input-history` is derived from `ouzhenkun/pi-input-history`.
- Preserve upstream LICENSE files and document local divergence.
- Never edit a reference checkout under `~/ghq/github.com/<upstream>`; copy or sync into this repository.

## Versioning

- Every package versions independently. Pick the bump by asking whether another
  package's code stops working: **major** only then (a removed export, a changed
  event/RPC payload shape, a protocol bump). **minor** for everything else that
  changes behavior, including retiring a settings key or a frontmatter field —
  those degrade with a warning rather than breaking a build. **patch** for a fix
  or for docs that ship in the package. A retired key must warn by name.
- A change to a package's published files (its manifest `files`) needs a
  changeset naming that package. `bun run check:changesets` enforces this; tests
  and repo tooling are exempt because they do not ship.
- A local version must never be behind npm's `latest` tag —
  `bun run check:versions` enforces this. Equal is the normal state after a
  release; ahead means a release is pending. The workspace baseline is 1.2.0,
  published in full; never re-baseline to a number npm has already seen.
- Do not add a package to `fixed` or `linked` to keep version numbers tidy. A
  version that moved without a change is a version that says nothing.

## Public repository

This repository is public and its packages ship to npm. Nothing here may
describe the maintainer's own machine, dotfile repository, or provisioning
setup.

- Never name a dotfile manager, its file paths, its templates, or its scripts.
  A constraint that comes from one is still real — restate it as a property of
  the package: not "the sync script preserves this key", but "a manager that
  owns this file must merge rather than overwrite".
- Never describe which packages a particular machine enables, or why. Say the
  package is opt-in and what it requires.
- Never cite a personal `AGENTS.md`/policy as the reason for a package's
  behavior. Give the technical reason instead.
- READMEs under `packages/` ship inside the npm tarball and render on npmjs.com.
  Hold them to this rule most strictly.

## Quality

- Use Pi's public APIs and `pi.events` for cross-extension communication.
- Avoid dynamic imports (except to defer loading a TUI-only dependency out of headless paths — see `docs/open-decisions.md`) and `any`; validate event-bus payloads at package boundaries.
- Guard TUI-only features with `ctx.mode === "tui"` and dialogs with `ctx.hasUI`.
- Run `bun run check` before committing.
- Add tests for state transitions, persistence, event ownership, and recovery behavior.

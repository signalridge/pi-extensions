# Changelog

## 1.2.3
### Patch Changes

- 1f586f8: Include real tool-result text in bounded side-question context, select remote checkpoints at Pi's effective compaction boundary, honor the public agent directory, restore branch-owned stamp state on tree navigation, and preserve commit evidence through retries until agent settlement.
- 1f586f8: - Bound workflow cancellation drains and durably fence unconfirmed cleanup, aborting sibling agents and releasing foreground callers.
  - Await managed timeout cleanup before script continuation and terminal publication.
  - Keep failed retry text and length responses discarded by overflow-compaction retry out of successful subagent fallbacks, while retaining valid pre-compaction and non-retried length output.
  - Account for native prompts spanning reporter activation without dropping out-of-order wait debt.
  - Reconcile settlement after observer-triggered manual compaction with run/session ownership.
  - Preserve clipped overlay hit ranges and native container ancestry for editor autocomplete focus.
  - Reconcile errored writes and edits against pre/post mutation evidence, retaining invocation cwd and releasing evidence when blocked or aborted preflight bypasses tool results.
- 1f586f8: Expand Pi peer support to `^0.84.0 || ^0.85.0`, retaining 0.84 compatibility while admitting 0.85 releases. The previous zero-major caret range excluded Pi 0.85.1. Update existing Pi development dependency pins to 0.85.1.
- 1f586f8: Cancel RPC question dialogs at the host, serialize LSP fixes with native file edits when the host provides a mutation queue, resolve workspace paths against session context, track successful shell commits, and report terminal-only commands explicitly over RPC.

## 1.2.2
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

## 1.2.1
### Patch Changes

- b6cf242: Peer dependency ranges now name the versions actually validated against, so an untested host combination fails at install time instead of silently at runtime: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core` move from `"*"` to `^0.84.0`, and `typebox` from `"*"` to `^1.3.11`.
  
  Shared dependencies now carry ONE declared range across every package that uses them, and `bun run check:shared-deps` keeps it that way.
  
  `@narumitw/pi-tui-kit` was declared at three disjoint floors — `^0.54.0`, `^0.51.0`, and `^0.49.1` across nine packages — and the lockfile duly resolved three copies (0.54.0, 0.51.0, 0.49.3) installed side by side. For a shared rendering surface drawing into one terminal inside one host process, that means a theme rendering one way in one extension and another way in the next, with nothing failing at install to say so. All nine now declare `^0.54.0` and the install resolves a single copy. `@sinclair/typebox` likewise converges on `^0.34.50`.
  
  The new check covers `dependencies` and `peerDependencies` and compares range strings rather than their semantics: two ranges that merely overlap are still a finding, because the goal is one intentional answer per dependency rather than an accidental intersection. `devDependencies` are deliberately out of scope — a build tool is not a shared surface, and `pi-subagents` intentionally carries its own toolchain. `docs/package-boundaries.md` documents the Kit as a shared surface for the first time.

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Patch Changes

- Neutralize terminal control sequences and bidirectional overrides in the last three surfaces that rendered untrusted text raw: the recap the model writes from tool output, the workspace facts on the startup card, and the directory name written into the terminal title as an OSC escape sequence. The recap also sanitizes transcript text before it truncates it, so a cut can never hand the model half of an escape sequence.
- Publish the screenshots and example template the README points at, so the npm page no longer renders broken images or a dead file reference.
- Read `PI_TAB_STATUS_STYLE` when a title is formatted instead of freezing it at module load, so the style is a runtime input rather than an import-time side effect, and cover the full run lifecycle in both the legacy and ridgeline styles.

## Unreleased

- Add the optional text-only Signalridge Ridgeline tab-title style while preserving the legacy emoji format.

## [0.1.4] - 2026-05-07

### Changed
- Declare the `@earendil-works` Pi peer and development dependencies used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## 0.1.3 - 2026-02-03
- Add preview image metadata for the extension listing.

## 0.1.2 - 2026-01-26
- Added note clarifying one active session per tab is tracked.

## 0.1.0 - 2026-01-13
- Initial release.

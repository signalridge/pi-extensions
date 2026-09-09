# Changelog

## 1.3.0
### Minor Changes

- 1f586f8: Forward mouse input through custom UI borders and align shell-editor mouse hit-testing with its rendered prompt. Keep Herdr working through automatic retries and integrate native, title-free UI waiting spans independently of event-bus blocked ownership.

### Patch Changes

- 1f586f8: - Bound workflow cancellation drains and durably fence unconfirmed cleanup, aborting sibling agents and releasing foreground callers.
  - Await managed timeout cleanup before script continuation and terminal publication.
  - Keep failed retry text and length responses discarded by overflow-compaction retry out of successful subagent fallbacks, while retaining valid pre-compaction and non-retried length output.
  - Account for native prompts spanning reporter activation without dropping out-of-order wait debt.
  - Reconcile settlement after observer-triggered manual compaction with run/session ownership.
  - Preserve clipped overlay hit ranges and native container ancestry for editor autocomplete focus.
  - Reconcile errored writes and edits against pre/post mutation evidence, retaining invocation cwd and releasing evidence when blocked or aborted preflight bypasses tool results.
- 1f586f8: Preserve Codex opaque checkpoints across Pi's retry-only assistant-tail removal using optional, fingerprint-verified version-1 proof plus explicit lifecycle provenance. Preserve that provenance across same-runtime reload without confusing a new identical assistant response with the persisted tail; persisted rebuilds reset it and unknown provenance fails closed. Bound BTW context and tool-argument construction, including suffix-key storage for wide JSON-shaped objects (enumeration remains linear). Balance out-of-order native UI waiting notifications without affecting manual blocked ownership. Foreground workflow cancellation waits for exact-owner quiescence even when stop is unavailable or rejects after reconciliation already stopped the child, including cancelled spawn allocation recovery; unconfirmed cleanup becomes durably non-resumable with a diagnostic retaining any stop error. Background execution remains detached.
  
  These are corrective changes: existing checkpoint fields, exports, and cross-extension protocols remain compatible, so no protocol or major-version bump is required.
- 1f586f8: Expand Pi peer support to `^0.84.0 || ^0.85.0`, retaining 0.84 compatibility while admitting 0.85 releases. The previous zero-major caret range excluded Pi 0.85.1. Update existing Pi development dependency pins to 0.85.1.

## 1.2.3
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

## 1.2.2
### Patch Changes

- b6cf242: Peer dependency ranges now name the versions actually validated against, so an untested host combination fails at install time instead of silently at runtime: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core` move from `"*"` to `^0.84.0`, and `typebox` from `"*"` to `^1.3.11`.
  
  Shared dependencies now carry ONE declared range across every package that uses them, and `bun run check:shared-deps` keeps it that way.
  
  `@narumitw/pi-tui-kit` was declared at three disjoint floors — `^0.54.0`, `^0.51.0`, and `^0.49.1` across nine packages — and the lockfile duly resolved three copies (0.54.0, 0.51.0, 0.49.3) installed side by side. For a shared rendering surface drawing into one terminal inside one host process, that means a theme rendering one way in one extension and another way in the next, with nothing failing at install to say so. All nine now declare `^0.54.0` and the install resolves a single copy. `@sinclair/typebox` likewise converges on `^0.34.50`.
  
  The new check covers `dependencies` and `peerDependencies` and compares range strings rather than their semantics: two ranges that merely overlap are still a finding, because the goal is one intentional answer per dependency rather than an accidental intersection. `devDependencies` are deliberately out of scope — a build tool is not a shared surface, and `pi-subagents` intentionally carries its own toolchain. `docs/package-boundaries.md` documents the Kit as a shared surface for the first time.

## 1.2.1
### Patch Changes

- 24a8af4: Remove references to the maintainer's personal dotfile setup from shipped docs
  and source comments. Each constraint is restated as a property of the package
  itself: which manager owns a settings file, whether a project permits git
  worktrees, and installing a package from a single source. No runtime behavior
  changes.

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

## 0.1.1
### Patch Changes

- 4c50252: Bind Pi lifecycle reports to Herdr's protocol-v8 session identity before sending state, normalize supported session-start sources, use the Windows named-pipe endpoint where required, and dispose the old reporter during session replacement. The canonical package remains `@signalridge/pi-herdr-state`; remove the legacy package name before installing it.

## Unreleased

- Added the canonical `@signalridge/pi-herdr-state` package at `packages/pi-herdr-state`.
- Fixed protocol-v8 session binding, TTY-only activation, Windows named-pipe endpoints, and serialized session-before-state reporting for Herdr 0.8+.
- The previously published `@signalridge/herdr-pi-state` name remains a legacy package because npm cannot rename packages; uninstall it before installing the canonical replacement.

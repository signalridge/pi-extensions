# Changelog

## 1.4.0
### Minor Changes

- 07350d4: Standardize extension-owned popup surfaces with an idempotent Pi-style border adapter. Native Pi dialogs retain their built-in framing and RPC behavior; custom menus and overlays gain consistent border rules.

### Patch Changes

- Updated dependencies [07350d4]
  - @signalridge/pi-ui@1.3.0

## 1.3.1
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

## 1.3.0
### Minor Changes

- b6cf242: `plan_mode_question` now asks a batch as a navigable sequence instead of a one-way run.
  
  The questions still arrive together and are answered one screen at a time, which is the right shape — a single screen holding four multi-option questions does not fit a terminal. What was missing was the navigation: no sense of how many questions remained, and no way back, so a misread option could only be fixed by cancelling the whole batch and making the model ask again.
  
  Each prompt now shows its position (`[2/4]`), and every question after the first offers a Back choice that returns to the previous one. Answers are held by position rather than appended, so revising one overwrites it instead of leaving a stale answer sitting behind its correction. An empty free-form answer now re-asks that question rather than cancelling the batch — opening the editor and thinking better of it is a correction, not a decision to discard everything already answered.
  
  A single question is unchanged: no position marker, and no Back affordance that could only ever cancel. Cancellation semantics are otherwise identical, including the plan-mode-ended check after every prompt.

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

## Unreleased

- Make Plan mode bash enforcement fail closed for shell composition, expansion, mutation, and unsafe Git or GitHub CLI arguments.
- Preserve an in-memory planning branch through fresh implementation replacement by snapshotting it as a private temporary parent session.
- Require `git --no-optional-locks status` and both `--no-ext-diff` and `--no-textconv` for Plan mode Git inspection.
- Reject bare `git branch` operands in Plan mode while allowing explicit read-only listing filters.
- Require `--no-ext-diff` and `--no-textconv` for patch-producing `git show` and `git log` inspection to prevent configured diff helpers from running.

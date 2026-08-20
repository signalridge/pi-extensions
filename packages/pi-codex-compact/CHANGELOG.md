# Changelog

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

- Bound the resume lineage walk's skip window by the checkpoint's own creation time as well as the rendered summary's timestamp, so a session file whose entry timestamp is later than the checkpoint — hand-edited, migrated, or resumed across a clock skew — can no longer drop a native compaction summary the opaque replacement does not cover. The injected checkpoint marker also always carries a finite timestamp, and an impossible lineage is rejected before hashing the rest of the context.
- Keep re-expanding the opaque Codex checkpoint after a session resume by tolerating replayed older compaction summaries interleaved with the retained messages, instead of silently dropping the remote history.

## Unreleased

- Accept legacy `@narumitw/pi-codex-compact` checkpoint summaries while validating checkpoint payloads and kept-message lineage.
- Skip malformed/native compaction entries when selecting the newest valid Codex checkpoint instead of masking an older recoverable checkpoint.
- Replay legacy `@narumitw/pi-codex-compact` checkpoint markers after reload by accepting and normalizing canonical and legacy marker variants.

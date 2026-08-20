# Changelog

## 1.3.1
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

## 1.3.0
### Minor Changes

- b6cf242: New `/worktree → Browse worktree status`: a readable view of what has actually changed in a worktree, grouped as conflicted / staged / unstaged / untracked.
  
  It reads `git status --porcelain=v2`, not the v1 the existing safety check uses. That check is unchanged and stays on v1, correctly — it only needs to know whether a worktree is dirty, and v1's flat lines answer that in the fewest moving parts. This is the other job: a person reads the result before deciding whether to remove, switch away from, or commit in a worktree, and "3 changes" does not settle any of those. v2 is what makes the listing unambiguous — staged and unstaged as separate values rather than one overloaded pair of letters, a rename's similarity score *and* its original path, unmerged entries flagged as conflicts rather than rendered as a misleading staged/unstaged pair, and submodules distinguished from modified files.
  
  Read with `-z`, so a path containing a newline or a quote is shown exactly as git wrote it. Parsing is total: an unrecognized record is skipped rather than throwing, so a future git version adding one costs that row and not the screen. `git.ts` keeps its raw-output boundary and stays free of intra-package imports — a test loads it standalone under Node's strip-only TypeScript, which cannot resolve a sibling `./x.js` to `x.ts` — so the parser lives beside it and is applied at the consumer.

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

### Patch Changes

- Strip Unicode bidirectional overrides — and DCS/PM/APC payloads in the footer and recall picker — from untrusted text before display, so a crafted branch name, worktree path, model id, or recalled message can no longer visually reverse what the user reads and acts on.
- Wire the hardened terminal sanitizers to the fields that actually carry hostile text, bound the escape-sequence skippers, and give worktree Add base-commit provenance.
  
  - `pi-statusline`: the `branch`, `provider`, and `tools` segments now pass through `sanitizeTerminalText`. The branch is sanitized before the GitHub PR context is composed in, so a hostile ref name can no longer emit raw OSC/CSI/bidi into the footer while the PR hyperlink keeps working.
  - `pi-statusline` / `pi-recall`: an escape-sequence introducer with no terminator now drops only itself instead of consuming the rest of the string, so a single `0x90` in a branch name or saved message no longer blanks a footer row, a preview, or the fuzzy-search text. SOS is handled alongside DCS/PM/APC.
  - `pi-recall`: previews are sanitized before truncation, so the preview budget is spent on visible characters instead of invisible escape bytes.
  - `pi-worktree`: line separators are replaced with a space instead of being dropped, so multi-line Git output no longer welds two records together inside a destructive confirmation body.
  - `pi-worktree`: Add resolves the base commit for both the create and the attach case (the attach case previously captured none, letting Git re-resolve the branch at exec time), shows the full base OID in the confirmation, and re-reads `git worktree list`, the local branch ref, and the base OID under the worktree mutation lock immediately before `git worktree add`. A base that moved, or a branch or path claimed while the dialog was open, refuses the add with a message naming both OIDs instead of silently creating a worktree from an unapproved base.

## 0.49.4
### Patch Changes

- 4c50252: Harden destructive worktree removal: refuse ignored local data, quarantine through Git's worktree-aware move, verify tree identity before each deletion, retain concurrent replacements, and isolate Git metadata pruning so cleanup cannot recursively delete late-created files.

## Unreleased

### Fixed

- Refuse removal whenever ignored local data is present, so cleanup never deletes unreviewed files; remove ignored data manually before retrying.
- Quarantine worktrees before deletion, verify the observed tree, and retain late-created data instead of racing recursive Git removal.
- Verify the tree snapshot across quarantine and before each deletion, retaining the quarantine when files or metadata change during removal.
- Revalidate the quarantined tree after the final Git inventory so ignored data created between the command check and quarantine is restored rather than deleted.
- Use Git's worktree-aware move for quarantine, so metadata removal targets the quarantined path and inverse Git moves restore failed removals safely.
- Move each quarantined entry to a private tombstone and recheck its identity before unlinking, retaining replacements detected during final deletion.
- Deregister Git worktree metadata with an exclusive non-directory reservation and isolated metadata prune after moving the real quarantine tree to a tombstone, so Git cannot recursively delete late-created or ignored data.

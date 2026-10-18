# Changelog

## 1.4.0
### Minor Changes

- 44cddda: Keep healthy startup, reload, resume, and new sessions quiet instead of displaying routine experimental warnings. Recall and Analytics retain their experimental lifecycle declarations and documentation without startup notices. Codex Compact shows its short portability warning only when the first remote checkpoint is committed in a UI-capable loaded extension instance; native, failed, and cancelled compactions do not trigger it. Invalid settings, storage failures, fallback failures, and incompatible-checkpoint warnings remain visible. No storage, authorization, checkpoint, or settings schema changes.

## 1.3.4
### Patch Changes

- c2fd867: Invalidate pending Recall interactions after committed session tree navigation, checking live branch ownership before callback mutations and canonical storage publication even when an earlier tree handler delays event delivery. Ordinary branch appends and cancelled navigation remain usable; delayed stale selections cannot save retired-branch messages or replace the current draft with a stale quote. Guard canonical permission repair during load/save/delete after awaited file inspection, and avoid a redundant pathname chmod after atomic replacement. Strictly decode UTF-8 and validate complete JSONL before permission repair so invalid canonical bytes and modes remain unchanged. Use the shared custom-editor adapter to preserve observable pre-completion destination writes without replaying over later writers.
- Updated dependencies [c2fd867]
  - @signalridge/pi-ui@1.4.0

## 1.3.3
### Patch Changes

- 3364cc0: Adopt Pi 1.0.4's host-provided dependency contract: declare imported Pi and TypeBox modules as `*` peers rather than installing duplicate runtime modules, and align Pi development pins with the repository's tested 1.0.4 baseline. The wildcard identifies host module ownership; it does not promise compatibility with every Pi version.
- 3364cc0: Protect clipboard transcripts with private isolated temporary files, decode Kitty printable filter input, and confirm RPC draft replacement with cancellable session/branch ownership so retired confirmations cannot overwrite a replacement draft. Escape unsafe recalled quote controls without changing stored text. Bound LSP tool output with private full-output spills and preserve concurrent per-session status ownership.
- Updated dependencies [3364cc0]
- Updated dependencies [3364cc0]
- Updated dependencies [3364cc0]
  - @signalridge/pi-ui@1.3.3

## 1.3.2
### Patch Changes

- 8190516: Extend the tested Pi host compatibility range through 0.87.x while retaining supported older hosts. Validate the published extensions against Pi 0.87.1 and adapt changed provider, session-context, and lifecycle contracts where necessary.
- 8190516: Add Pi 0.99.1 to the supported host peer ranges while retaining Pi 0.84–0.87 compatibility. Align Pi development dependency pins with 0.99.1 for validation against the new host.
- Updated dependencies [8190516]
- Updated dependencies [8190516]
  - @signalridge/pi-ui@1.3.2

## 1.3.1
### Patch Changes

- 1f586f8: Expand Pi peer support to `^0.84.0 || ^0.85.0`, retaining 0.84 compatibility while admitting 0.85 releases. The previous zero-major caret range excluded Pi 0.85.1. Update existing Pi development dependency pins to 0.85.1.
- d9219d4: Converge every README on one house style: plain sentence-case headings, no
  decorative emoji.
  
  Ten packages carried an emoji heading scheme inherited from their upstream
  forks while the other nineteen used plain headings, so the same monorepo
  rendered as two unrelated projects on npmjs.com. Headings are now emoji-free
  and titles are sentence case.
  
  Also removes the `Keywords` section from those ten. It duplicated each
  package's `package.json` `keywords` field, which is what npm actually indexes,
  and no plain-style README carried one. `Installation` is now `Install`
  everywhere.
  
  Headings that were Title Case are sentence case too, so one convention now
  covers the whole monorepo. Existing in-page anchor links are unaffected:
  GitHub lowercases heading slugs already.
  
  Documentation only — no runtime change.
- Updated dependencies [1f586f8]
- Updated dependencies [1f586f8]
- Updated dependencies [1f586f8]
- Updated dependencies [1f586f8]
  - @signalridge/pi-ui@1.3.1

## 1.3.0
### Minor Changes

- 07350d4: Standardize extension-owned popup surfaces with an idempotent Pi-style border adapter. Native Pi dialogs retain their built-in framing and RPC behavior; custom menus and overlays gain consistent border rules.

### Patch Changes

- Updated dependencies [07350d4]
  - @signalridge/pi-ui@1.3.0

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

- Strip Unicode bidirectional overrides — and DCS/PM/APC payloads in the footer and recall picker — from untrusted text before display, so a crafted branch name, worktree path, model id, or recalled message can no longer visually reverse what the user reads and acts on.
- Wire the hardened terminal sanitizers to the fields that actually carry hostile text, bound the escape-sequence skippers, and give worktree Add base-commit provenance.
  
  - `pi-statusline`: the `branch`, `provider`, and `tools` segments now pass through `sanitizeTerminalText`. The branch is sanitized before the GitHub PR context is composed in, so a hostile ref name can no longer emit raw OSC/CSI/bidi into the footer while the PR hyperlink keeps working.
  - `pi-statusline` / `pi-recall`: an escape-sequence introducer with no terminator now drops only itself instead of consuming the rest of the string, so a single `0x90` in a branch name or saved message no longer blanks a footer row, a preview, or the fuzzy-search text. SOS is handled alongside DCS/PM/APC.
  - `pi-recall`: previews are sanitized before truncation, so the preview budget is spent on visible characters instead of invisible escape bytes.
  - `pi-worktree`: line separators are replaced with a space instead of being dropped, so multi-line Git output no longer welds two records together inside a destructive confirmation body.
  - `pi-worktree`: Add resolves the base commit for both the create and the attach case (the attach case previously captured none, letting Git re-resolve the branch at exec time), shows the full base OID in the confirmation, and re-reads `git worktree list`, the local branch ref, and the base OID under the worktree mutation lock immediately before `git worktree add`. A base that moved, or a branch or path claimed while the dialog was open, refuses the add with a message naming both OIDs instead of silently creating a worktree from an unapproved base.

## Unreleased

- Refresh package metadata and Pi namespace compatibility.

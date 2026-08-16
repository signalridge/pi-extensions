# Changelog

## 1.3.0
### Minor Changes

- 8488246: Say whose status it is.
  
  `extensionStatusIcons` is empty by default, so a status rendered as bare text
  with nothing identifying it: the footer read `6 servers enabled · active ·
  ready` with no way to tell which extension was speaking. When a status has no
  configured icon, its key now labels it — `mcp 6 servers enabled`, `goal active`.
  The icon was carrying that job invisibly, and turning icons off took the label
  with it.
  
  Badge stripping also moves ahead of the key-prefix strip. `pi-mcp-adapter`
  writes either `MCP: …` or `🔌 MCP: …` depending on one of its settings, and with
  the badge still attached the value no longer began with the key, so the
  redundant `MCP:` prefix survived in one form and was stripped in the other.
  Both now reduce to the same text, and the new label is never doubled.

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

- Moved the theme-native text-first statusline into the independently publishable Signalridge package.
- Deduplicate response updates without provider response IDs and initialize a stable fallback key for each turn.
- Scope provider-local response IDs and repeated tool-call IDs so switching providers or turns cannot overwrite another usage contribution.
- Rebuild historical tool-result identities at assistant-turn boundaries so repeated tool-call IDs remain additive.

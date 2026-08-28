# Changelog

## 1.2.4
### Patch Changes

- 28c8aa1: Remove non-functional references to external product names from package descriptions, examples, and comments. Provider identifiers required for runtime compatibility remain unchanged.

## 1.2.3
### Patch Changes

- 07350d4: Use the theme's `borderAccent` color for extension-owned outer borders so the popup and welcome-card framing follows the purple Signalridge palette.

## 1.2.2
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

## 1.2.1
### Patch Changes

- b6cf242: Peer dependency ranges now name the versions actually validated against, so an untested host combination fails at install time instead of silently at runtime: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core` move from `"*"` to `^0.84.0`, and `typebox` from `"*"` to `^1.3.11`.
  
  Shared dependencies now carry ONE declared range across every package that uses them, and `bun run check:shared-deps` keeps it that way.
  
  `@narumitw/pi-tui-kit` was declared at three disjoint floors — `^0.54.0`, `^0.51.0`, and `^0.49.1` across nine packages — and the lockfile duly resolved three copies (0.54.0, 0.51.0, 0.49.3) installed side by side. For a shared rendering surface drawing into one terminal inside one host process, that means a theme rendering one way in one extension and another way in the next, with nothing failing at install to say so. All nine now declare `^0.54.0` and the install resolves a single copy. `@sinclair/typebox` likewise converges on `^0.34.50`.
  
  The new check covers `dependencies` and `peerDependencies` and compares range strings rather than their semantics: two ranges that merely overlap are still a finding, because the goal is one intentional answer per dependency rather than an accidental intersection. `devDependencies` are deliberately out of scope — a build tool is not a shared surface, and `pi-subagents` intentionally carries its own toolchain. `docs/package-boundaries.md` documents the Kit as a shared surface for the first time.
- b6cf242: Real test coverage for the four packages that had almost none. No behaviour changes; the only source edit is that `pi-input-history` now exports the pure helpers its tests drive.
  
  - **pi-input-history** (606 lines of source, previously a 21-line registration smoke test): 34 tests over the logic that decides which prompts the Ctrl+R popup shows and in what order — the fuzzy matcher's ordering and token rules, the cross-session merge and its dedup precedence, timestamp parsing, and the age labels.
  - **pi-gpt-fast** (previously an 18-line registration smoke test): 19 tests over the one decision the extension makes — whether a request carries `service_tier: "priority"`. Covers the exact-pair allowlist (a lookalike provider on the same model id must not match), payload preservation, non-object payloads, toggle and argument handling, settings persistence including the read-modify-write that protects pi's own keys, and the `fast` vs `fast (armed)` distinction.
  - **pi-input-prefix** (previously a linear assertion script with no named tests): the same assertions, now 31 named `node:test` cases plus new coverage for label insetting, one-column rules, slash-token boundaries, and shell-bang detachment edge cases. A failure now names the case instead of aborting the file at the first bad assertion.
  - **pi-ralph-wiggum** (previously one linear script in a `try`/`finally`): 18 named cases covering loop ownership across sessions, what a former owner may no longer do after ownership transfers, loop lifecycle transitions, and legacy state migration.

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

## Unreleased

- Moved the dotfiles history popup into the independently publishable Signalridge package.

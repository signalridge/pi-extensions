# Changelog

## 1.2.6
### Patch Changes

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

## 1.2.5
### Patch Changes

- c1b1741: Durability and containment fixes found in a repository-wide scan.
  
  `pi-gpt-fast` rewrote pi's own global `settings.json` with a plain
  `writeFileSync`. That file is shared with pi and every other extension, and this
  one is the only writer of it; a torn write would have left the user with no pi
  configuration at all rather than just no gpt-fast setting. It now writes a temp
  file and renames, matching every other settings writer in the repository.
  `pi-goal` gets the same treatment for its cross-project goal state file, which
  its own settings module already did.
  
  `pi-ralph-wiggum` resolved `/ralph start <path>` straight against the session
  cwd, so `../../notes.md` would create directories and a file outside the project
  the user opened — silently, before the loop started. This extension drives long
  unattended loops, so that command is as likely to come from a model as from a
  person. Task-file paths are now required to stay inside the workspace, on the
  command, on the `ralph_start` tool, and on the paths read back out of persisted
  state, so a state file written earlier or edited by hand cannot pull a file in
  from outside either.
  
  The containment test canonicalizes both sides before comparing, because a purely
  lexical one is defeated by a symlink: every segment of `linked/plan.md` reads as
  inside the workspace when `linked` is a door out of it. `realpathSync` throws on
  a path that does not exist yet — the ordinary case, since `start` is usually
  creating the file — so it resolves the deepest existing ancestor and re-attaches
  the not-yet-created suffix, which cannot itself be a link. The traversal test
  matches a `..` segment rather than a `..` prefix; the prefix form also rejected
  `..notes.md`, an ordinary filename sitting in the workspace.
  
  Every remaining bare `catch {}` now says why the error is safe to drop, matching
  the convention the rest of the repository already follows.

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

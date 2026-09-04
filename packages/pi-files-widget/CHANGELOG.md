# Changelog

## 1.2.4
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
- b6cf242: `pi-statusline` now has a single `/statusline` registration path. `registerStatuslineCommand()` existed but had no production caller — the runtime registered the command inline with its own session guard — so the tests exercised a wrapper the product never ran, and the guard existed on only one of the two paths. The runtime now goes through `registerStatuslineCommand()`, which takes the session check as an `isCurrentSession` option, so the covered path and the shipped path are the same one.
  
  `pi-files-widget`'s `DESIGN.md` now states up front that it is a design document rather than a description of the shipped surface: the extension registers one command, `/readfiles`, while the document's *Proposed* and *Phase 2/3* sections describe `/review`, `/diff`, and external `tuicr`/`critique` integrations that do not exist.

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Patch Changes

- Run the file viewer's `git diff`, `delta`, `glow`, and `bat` invocations through `execFileSync` argv arrays so a repository-controlled filename such as `report$(id).md` can no longer execute a shell command, and correct two `git.ts` parsers: a `-z` rename now lists the surviving path instead of the deleted origin, and staged lines are counted once instead of twice in the diff-stat gutter.
- Harden the file viewer's git and rendering paths: `git diff` now passes `--no-ext-diff`, so a configured `diff.external`/`GIT_EXTERNAL_DIFF` can no longer replace the unified diff the viewer parses (and can no longer break `-`-prefixed filenames it receives as bare positionals); `git.ts` runs every call through `execFileSync` argv instead of `/bin/sh`; `git status` now uses `-uall` for untracked paths, so a file inside an untracked directory gets the same badge the browser already lists it with, while ignored directories stay collapsed; `glow`/`bat` failures no longer leak child stderr into the TUI; and diff wrapping measures terminal cells, so CJK text no longer overflows the pane and emoji are no longer split mid-surrogate.

All notable changes to this extension will be documented in this file.

## Unreleased

### Changed
- Reduce Pi startup work by checking required commands directly on `PATH` instead of spawning `which`/`where`, and load the file-browser implementation only when `/readfiles` is invoked.
- Git metadata is collected with argv arrays instead of `/bin/sh` command strings, removing seven shell spawns per browser load.

### Fixed
- Diffs are rendered by the widget, not by a configured external differ. `git diff` now runs with `--no-ext-diff`, so a `diff.external`/`GIT_EXTERNAL_DIFF` such as `difftastic` no longer replaces the unified diff that `delta` and the built-in wrapper expect — which also means a file whose name starts with `-` really does open, instead of being passed to the external tool as a bare positional.
- Untracked files inside an untracked directory now carry a status badge. `git status` is asked for `-uall` to match the file list the browser builds; ignored directories are still collapsed to a single row rather than expanded file by file.
- A failing `glow` or `bat` no longer prints its error into the alternate screen. Both fallbacks capture child stderr like the `git`/`delta` calls already did.
- Diff wrapping counts terminal cells instead of UTF-16 code units, so CJK lines no longer overflow the pane by up to double the width and emoji are no longer split into surrogate halves.
- Opening a file no longer runs its name through a shell. `git diff`, `delta`, `glow`, and `bat` are now invoked with argv arrays, so a repository-controlled filename such as `report$(id).md`, ``back`id`tick.md``, or `a"b.txt` is passed through verbatim instead of being interpreted by `/bin/sh`. Such files also now open correctly rather than failing to load.
- A renamed file is listed under its new path. `git status --porcelain -z` reverses rename fields, so the browser previously showed a phantom entry for the deleted original name.
- The diff-stat gutter counts staged lines once. `git diff HEAD` already spans the index, so summing it with `git diff --cached` doubled the additions and deletions shown for any staged file.

## [0.2.0] - 2026-07-04

### Added
- `/readfiles` now supports browsing outside the current working directory. Press `u` to re-root to the parent, `.` to jump back to where you started, or pass an explicit starting path (`/readfiles <path>` or `/readfiles ~/somewhere`). The browser header shows the current root so you always know where you are, and comments on files outside the project use absolute paths so the agent can still find them.

### Fixed
- Git status, diff stats, and untracked-file discovery now work when the browser root is a subdirectory of the git repository (e.g. after `u`, `.`, or `/readfiles <subdir>`, or when pi runs from a repo subdirectory). Previously repo-root-relative git paths were mixed with root-relative node keys, producing phantom tree entries, missing statuses, and unopenable nested paths.
- Re-rooting the browser while a background directory scan or line-count batch is in flight no longer lets the stale batch mutate the new root's tree, node index, or scan state.
- Use `where` instead of `which` on Windows to detect `bat`, `delta`, and `glow`, so the dependency check works when running from PowerShell or cmd.exe.

## [0.1.21] - 2026-05-07

### Changed
- Declare `@earendil-works` Pi development dependencies used by runtime imports.
- Update Pi extension imports and peer dependencies to the new `@earendil-works` namespace.


## [0.1.20] - 2026-04-24

### Removed
- Remove the external `/readfiles-review` and `/readfiles-diff` commands so files-widget stays focused on the `/readfiles` browser/viewer.


## [0.1.18] - 2026-04-19

### Changed
- Show symlinks with a `↗` marker in the `/readfiles` tree.

### Fixed
- Let `/readfiles` navigate into directory symlinks in both non-git folders and git repos instead of rendering them as inert files or empty directories.
- Guard symlink directory scanning against ancestor cycles so links like `foo -> .` or `foo -> ..` don't recurse forever.
- Treat git-tracked and untracked directory symlinks as lazily scannable directories rather than plain files.

### Thanks
- Thanks to @xapids for reporting the original macOS symlink navigation issue ([#9](https://github.com/tmustier/pi-extensions/issues/9)).

## [0.1.17] - 2026-04-19

### Changed
- Make the inline comment editor multiline with wrapped footer rendering, `Enter` for a new line, and `Ctrl+Enter`/`Ctrl+D` to send.
- Add an `m` toggle for rendered vs raw Markdown in the viewer, and fall back to raw mode before line-based search or selection.
- Show a sent/queued confirmation toast after returning an inline comment to the agent.

### Thanks
- Thanks to avg8888 in the Pi Discord for surfacing the comment editor and Markdown review issues fixed in this release.

## [0.1.16] - 2026-04-19

### Fixed
- Let `/readfiles` browser search accept `j` and `k` as search text instead of hijacking them for navigation.
- Fix viewer scrolling so the last lines of a file remain reachable.
- Restore `G` / `Shift+G` navigation to jump to the bottom of the viewer.
- Refresh an open viewer when the file changes on disk while `/readfiles` is open.
- Accept pasted, multi-character, and chunked bracketed-paste input in browser search and the inline comment prompt.
- Keep viewer search results in sync after live refreshes.
- Pause live refresh while a line selection or inline comment is active so comments stay anchored to what the user selected.

## [0.1.14] - 2026-02-03

### Added
- Add preview video metadata for the extension listing.

## [0.1.13] - 2026-02-02

### Changed
- **BREAKING:** Renamed `/files` command to `/readfiles` to avoid conflict with Pi's new built-in `/files` command (Pi v0.50.2+)

## [0.1.11] - 2026-01-26

### Changed
- Require `bat`, `delta`, and `glow` before opening `/files`
- Add a postinstall reminder for required system tools
- Document install commands next to the Pi install steps

## [0.1.10] - 2026-01-26

### Fixed
- Treat git-reported directory entries as directories to avoid viewer errors
- Guard the viewer against opening directories directly
- Wrap delta diff output without breaking gutters and avoid truncation
- Add a safe fallback when `bat` fails to render with wrapping

## [0.1.9] - 2026-01-26

### Changed
- Bind render requests to avoid undefined context with the latest pi-tui

## [0.1.8] - 2026-01-26

### Changed
- Compute line counts asynchronously with loading indicators
- Build git repo trees from git file lists to avoid filesystem scans
- Add progressive filesystem scanning with safe mode for large folders
- Reduce refresh work to git metadata updates

## [0.1.7] - 2026-01-26

### Changed
- Cache line counts and skip large files to avoid freezes in big folders
- Avoid recomputing tree stats on every render
- Preserve line counts for open files across refreshes

## [0.1.6] - 2026-01-24

### Added
- Clearer install instructions and dependency notes in README

## [0.1.5] - 2026-01-24

### Added
- Demo recording embedded in README

### Changed
- Comment sending now queues with follow-up delivery in streaming sessions
- Split viewer logic into `viewer.ts` and shared helpers
- Reduced browser render duplication with node format helpers

## [0.1.4] - 2026-01-24

### Changed
- Split viewer logic into `viewer.ts` and shared helpers
- Reduced browser render duplication with node format helpers

## [0.1.3] - 2026-01-24

### Changed
- `c` in viewer now opens an inline comment prompt and sends a follow-up message

## [0.1.2] - 2026-01-24

### Changed
- `c` in viewer now appends selection to editor input instead of sending immediately

## [0.1.1] - 2026-01-24

### Added
- README with install steps, dependencies, and keybindings

### Changed
- Refactored into modular files (browser, git, tree, viewer, utils)

## [0.1.0] - 2026-01-24

### Added
- `/files` command opens full-screen file browser
- File tree with j/k navigation, Enter to open, h/l to collapse/expand
- File viewer with syntax highlighting via `bat`
- Markdown rendering via `glow`
- Git diff view via `delta` with line numbers
- Git status indicators (M, A, D, ?) on files
- Agent-modified file tracking (🤖 indicator)
- Changed files filter (`c` to toggle)
- Jump to next/prev changed file (`]`/`[`)
- Search in file tree (`/` then type)
- Search in file viewer (`/` then type, `n`/`N` for next/prev match)
- Select mode (`v`) to select lines and comment (`c`) to send to agent
- Line counts and diff stats (+/-) on files and collapsed folders
- Auto-refresh git status every 3 seconds (preserves expansion state)
- PageUp/PageDown support in browser and viewer
- Height adjustment (`+`/`-`)
- Works in non-git directories (git features gracefully disabled)

### Dependencies
- `bat` - syntax highlighting (recommended)
- `glow` - markdown rendering (recommended)
- `delta` - diff formatting (recommended)

Install with: `brew install bat git-delta glow`

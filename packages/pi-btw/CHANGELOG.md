# @signalridge/pi-btw

## 1.3.1
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

### Minor Changes

- Add session- and branch-scoped, in-memory resumable side threads with a bounded searchable picker, stable IDs, activity ordering, and thread-local thinking levels while keeping direct questions fresh and avoiding disk persistence.

## 0.49.7

### Patch Changes

- 3f33860: Run side threads in a dedicated full-screen TUI so mouse-drag copying stays stable while the main agent continues producing output in the background.
- 2a2c9c1: Queue Pi-style steering questions while a side-thread answer is running, process them one at a time without touching the main conversation, and report malformed side-model responses without hanging the side UI.

## 0.49.6

### Patch Changes

- a4b44ee: Route side-question completions through Pi's effective runtime provider so custom provider APIs work.

# Changelog

## 1.3.4
### Patch Changes

- 07350d4: Use the theme's `borderAccent` color for extension-owned outer borders so the popup and welcome-card framing follows the purple Signalridge palette.

## 1.3.3
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

## 1.3.2
### Patch Changes

- b6cf242: Peer dependency ranges now name the versions actually validated against, so an untested host combination fails at install time instead of silently at runtime: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core` move from `"*"` to `^0.84.0`, and `typebox` from `"*"` to `^1.3.11`.
  
  Shared dependencies now carry ONE declared range across every package that uses them, and `bun run check:shared-deps` keeps it that way.
  
  `@narumitw/pi-tui-kit` was declared at three disjoint floors — `^0.54.0`, `^0.51.0`, and `^0.49.1` across nine packages — and the lockfile duly resolved three copies (0.54.0, 0.51.0, 0.49.3) installed side by side. For a shared rendering surface drawing into one terminal inside one host process, that means a theme rendering one way in one extension and another way in the next, with nothing failing at install to say so. All nine now declare `^0.54.0` and the install resolves a single copy. `@sinclair/typebox` likewise converges on `^0.34.50`.
  
  The new check covers `dependencies` and `peerDependencies` and compares range strings rather than their semantics: two ranges that merely overlap are still a finding, because the goal is one intentional answer per dependency rather than an accidental intersection. `devDependencies` are deliberately out of scope — a build tool is not a shared surface, and `pi-subagents` intentionally carries its own toolchain. `docs/package-boundaries.md` documents the Kit as a shared surface for the first time.

## 1.3.1
### Patch Changes

- 2f22dea: Give the card its head back, with a mark that says which tool this is.
  
  1.3.0 removed the whole title block. Only the wordmark was meant to go: the
  tagline went with it because it sat on the same two lines, which left the card
  opening straight into a key-hint row with nothing naming the session's tool or
  version.
  
  The two rows are back, now `pi` and its version over the tagline, with a pi
  letterform for a mark — one beam over two legs, drawn from Block Elements so
  every glyph is exactly one column in every terminal font. It says the same thing
  as the title beside it rather than being a texture that could belong to any
  tool, which the previous rounded outline and the solid bar that briefly replaced
  it both were. The separate `Version` row is gone, since the version now rides
  the title it belongs to.

## 1.3.0
### Minor Changes

- 8488246: Put the inventory back, and take the wordmark off.
  
  With `quietStartup` on, Pi's `[Context]`/`[Skills]`/`[Prompts]`/`[Themes]`/
  `[Extensions]` sections are gone and nothing brings them back — `/reload` re-runs
  the same suppressed listing. The card had replaced all of that with three
  counts, which is strictly less than what the session used to show. It now names
  them instead, eight per row with a `+N` tail: context files, skills, prompts,
  extensions, themes, and the tool count.
  
  Skills and prompts now come from `getCommands()` rather than `loadSkills()`. An
  extension may contribute skill paths through `resources_discover`, which is
  where most of them come from in practice, and the standalone loader cannot see
  those — measured on a real session it returned zero skills while Pi was showing
  dozens. Extensions and themes are read from the same settings files and
  directories Pi reads.
  
  The ridgeline mark, the `SIGNALRIDGE / PI` wordmark, and the tagline are gone.
  The card exists to say what this session is, and a brand line says nothing a
  returning user does not already know; the key hints lead instead, since with
  `quietStartup` on they appear nowhere else. The Pi version returns to a row of
  its own.

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Patch Changes

- Neutralize terminal control sequences and bidirectional overrides in the last three surfaces that rendered untrusted text raw: the recap the model writes from tool output, the workspace facts on the startup card, and the directory name written into the terminal title as an OSC escape sequence. The recap also sanitizes transcript text before it truncates it, so a cut can never hand the model half of an escape sequence.

## Unreleased

- Moved the Pi startup card into the independently publishable Signalridge package.
- Keep Pi's native resource listing enabled; the card no longer attempts to rebuild the private resource loader.
- Refined the card with original Signalridge Ridgeline branding and a width-safe compact layout.

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

- Stop declaring the provider context files in `templates/` as Agent Skills, removing three "description is required" loader warnings on every startup.

## [0.1.5] - 2026-05-07

### Changed
- Declare the `@earendil-works/pi-coding-agent` peer and development dependency used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## 0.1.4 - 2026-04-28

### Changed
- Templates simplified to focus on durable behavioural overrides:
  - `CODEX.md`: replaces the previous agent-protocol prose with two blocks for OpenAI models — `<solution_persistence>` (autonomy + bias for action + persist till done + no quality-for-tokens trade) and `<validation>` (run validators before summarizing or committing; fix failures before finalizing).
  - `GEMINI.md`: replaces the empty placeholder with a `<tool_usage_rules>` block that steers Gemini to pi's `read`/`write`/`edit` tools instead of `cat`/heredoc/`sed -i`/etc.

## 0.1.3 - 2026-02-03

### Changed
- Publish metadata refresh (no runtime changes).

## 0.1.2 - 2026-02-02

### Changed
- **BREAKING:** Changed `before_agent_start` handler to use `systemPrompt` instead of deprecated `systemPromptAppend` (Pi v0.39.0+)

## 0.1.0 - 2026-01-13
- Initial release.

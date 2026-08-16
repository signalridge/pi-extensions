# Changelog

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

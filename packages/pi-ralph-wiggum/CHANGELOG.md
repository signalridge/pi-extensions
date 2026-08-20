# Changelog

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

## [0.2.3] - 2026-07-21

### Fixed
- Bind active Ralph loops to their owning Pi session. Reloads and compaction restore only that session's loop; unrelated sessions sharing the same working directory no longer receive Ralph prompt injection or mutate the loop. `/ralph resume <name>` explicitly transfers ownership.

Thanks to @juicetin for the detailed report, regression test, and implementation ([#50](https://github.com/tmustier/pi-extensions/issues/50), [#52](https://github.com/tmustier/pi-extensions/pull/52)).

### Documentation
- Clarify that Ralph iterations are turns within one Pi session and context window, with normal Pi compaction, rather than fresh sessions per iteration.

Thanks to @rhossack and @RichardScottOZ for prompting the clarification ([#46](https://github.com/tmustier/pi-extensions/issues/46)).

## [0.2.2] - 2026-07-04

### Changed
- Add a completion gate to Ralph prompts and skill guidance. Agents are now instructed to preserve required verification artifacts and record an exact monitor-rerunnable final command before emitting `<promise>COMPLETE</promise>`.
- Deliver all Ralph-scheduled prompts (loop start, resume, iteration, and completion banner) with `deliverAs: "followUp"` so messages queue cleanly instead of steering when the agent is still processing.
- Add a stale-prompt guard instructing agents to reload loop state and ignore already-completed loops instead of doing duplicate work.

Thanks to @jorgecurious for contributing the completion gate, follow-up delivery, and stale-prompt guard ([#40](https://github.com/tmustier/pi-extensions/pull/40)).

## [0.2.1] - 2026-05-07

### Changed
- Declare the `@earendil-works/pi-coding-agent` peer and development dependency used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## 0.2.0 - 2026-04-19

### Changed
- **BREAKING:** SKILL.md `name` renamed `ralph-wiggum` → `pi-ralph-wiggum` to match the parent directory (both in the repo and after `pi install npm:@tmustier/pi-ralph-wiggum`). This removes the `[Skill conflicts]` warning pi emitted on every startup, but it also changes the skill's public identifier — explicit invocations must now use `/skill:pi-ralph-wiggum` instead of `/skill:ralph-wiggum`. Thanks to @ishanmalik for reporting ([#12](https://github.com/tmustier/pi-extensions/issues/12)).
- Repo directory renamed `ralph-wiggum/` → `pi-ralph-wiggum/` as part of the same fix. Git-source users referencing `~/pi-extensions/ralph-wiggum/…` in their pi config should update the path to `~/pi-extensions/pi-ralph-wiggum/…`. The npm package name (`@tmustier/pi-ralph-wiggum`) is unchanged.
- Renamed the README's `Install` section to `Installation` so it matches the skill validator's expectations.

## 0.1.7 - 2026-04-19

### Fixed
- Ralph loops no longer silently stop after auto-compaction or `/compact`. On session reload, `currentLoop` is now rehydrated from the on-disk state (most-recently-updated active loop wins on ties), so `ralph_done`, `agent_end`, and `before_agent_start` continue to function. Thanks to @elecnix for the detailed report and proposed fix ([#11](https://github.com/tmustier/pi-extensions/issues/11)).

## 0.1.5 - 2026-02-03

### Added
- Add preview image metadata for the extension listing.

## 0.1.4 - 2026-02-02

### Changed
- **BREAKING:** Updated tool execute signatures for Pi v0.51.0 compatibility (`signal` parameter now comes before `onUpdate`)
- **BREAKING:** Changed `before_agent_start` handler to use `systemPrompt` instead of deprecated `systemPromptAppend` (Pi v0.39.0+)

## 0.1.3 - 2026-01-26
- Added note clarifying this is a flat version without subagents.

## 0.1.1 - 2026-01-25
- Clarified that agents must write the task file themselves (tool does not auto-create it).

## 0.1.0 - 2026-01-13
- Initial release.

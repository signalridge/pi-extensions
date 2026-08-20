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

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Minor Changes

- Sync the tmustier session-recap 0.5.0 behavior for explicit Codex reasoning-off and temporary fullscreen transcript recaps with defensive lifecycle cleanup.

### Patch Changes

- Neutralize terminal control sequences and bidirectional overrides in the last three surfaces that rendered untrusted text raw: the recap the model writes from tool output, the workspace facts on the startup card, and the directory name written into the terminal title as an OSC escape sequence. The recap also sanitizes transcript text before it truncates it, so a cut can never hand the model half of an escape sequence.
- Publish the screenshots and example template the README points at, so the npm page no longer renders broken images or a dead file reference.

## [0.4.1] - 2026-08-06

### Changed
- Simplified the extension implementation and documentation without changing recap behaviour.

## [0.4.0] - 2026-08-06

### Changed
- Replace the flattened 12,000-character transcript with a 30-message native conversation window, the initial request, and the latest compaction or branch summary. Long initial requests and tool results retain their beginning and end.
- Use Claude Code's recap instruction verbatim, removing the extra file/error rules and the 600-character output truncation.

## [0.3.0] - 2026-08-06

### Fixed
- Let Pi wrap recap text at the terminal width instead of inserting breaks at 100 characters.

### Changed
- Prefer Claude Haiku 4.5 for Anthropic sessions, or GPT-5.6 Luna when the active model is GPT and its provider offers Luna. Fall back to the active model; `--recap-model` still takes precedence.

## [0.2.2] - 2026-07-21

### Fixed
- Skip recap generation silently when the active model uses a custom API handler that is registered only in Pi's runtime and cannot be resolved by pi-ai's standalone compatibility layer. Users can still select a supported recap model with `--recap-model`.
- Publish the metadata-only branch deduplication fix listed under 0.2.1. Version 0.2.2 is the first npm release since 0.2.0.

Thanks to @timvdhoorn for reporting and fixing the custom-provider failure ([#81](https://github.com/tmustier/pi-extensions/pull/81)).

## [0.2.1] - 2026-07-05

### Fixed
- Avoid redundant automatic recap generation when the recap prompt has not changed, even if Pi has advanced the session leaf with metadata-only entries (for example session info, model/thinking changes, labels, or leaf markers). Dedupe now uses a fingerprint of the capped recap transcript rather than the raw branch leaf id.

## [0.2.0] - 2026-07-04

Away-recap redesign informed by Claude Code's away-summary implementation.

### Fixed
- **Restore recap generation on pi 0.80.x**: import `completeSimple`/`getModel` from `@earendil-works/pi-ai/compat` — the root export dropped them, which silently broke v0.1.3 at runtime.
- Stop requiring `auth.apiKey`: env/ambient-auth providers (e.g. Bedrock) resolve with `ok: true` and no key. Only bail when auth resolution fails, and pass `env` through to the completion call.

### Changed
- **Triggers**: recaps are no longer drafted on every focus-out. A recap is generated after `--recap-away-seconds` (default 90) of continuous blur, or when a turn ends while the terminal is blurred (3s debounce). Quick alt-tabs no longer fire (and then abort) model calls.
- **Idle fallback is now conditional**: armed only while the terminal has not demonstrated focus-reporting support; the first real focus event disarms it for the session. Default raised 45s → 120s.
- **Prompt**: adopted Claude Code's orientation philosophy — 1-3 short sentences, high-level task first, concrete next step, explicitly skipping status reports and commit recaps. v0.1 asked for a status report of the last turn, which duplicated what was already in scrollback.
- **Context**: two-tier transcript — recent detail since the last user message (as before), plus cheap task framing: up to 4 earlier user prompts (trimmed to 300 chars) and the most recent compaction/branch summary. Same 12k-char overall cap, so worst-case cost is unchanged.
- **Widget**: recap can now span 1-3 sentences, soft-wrapped to at most 4 dim lines.
- Recaps generated while away are shown immediately (parked above the editor for your return) instead of being held for reveal on focus-in.
- An in-flight draft is no longer cancelled on refocus — it lands moments after you return, which is when it helps.
- Resume/fork recaps use the same two-tier builder instead of feeding the entire branch.

### Added
- `--recap-away-seconds <n>` (default 90) — continuous blur before an away recap.

### Removed
- `--recap-focus-min-seconds` — no drafts on focus-out means no quick-glance suppression to tune, and the `pendingRecap` park/reveal/cancel machinery is gone with it.

## [0.1.3] - 2026-05-12

### Fixed
- Defer focus-triggered recaps while the agent is still active, matching Claude Code's away-summary pending behavior and avoiding duplicate/stale recaps during slow tool calls.
- Cancel stale in-flight recap drafts when a new turn starts.
- Skip `/resume` and `/fork` recap generation in headless/non-UI sessions.
- Read registered flag values using bare flag names (for example `recap-idle-seconds`, not `--recap-idle-seconds`) so automatic trigger configuration actually takes effect.
- Invoke recap generation with no reasoning, no prompt-cache retention, and `maxTokens: 256`.

### Added
- Add `--recap-during-active` to opt back into focus-triggered recaps while an agent turn is still running.

## [0.1.2] - 2026-05-07

### Changed
- Declare the `@earendil-works` Pi peer and development dependencies used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## v0.1.0

- Initial release.
- Two triggers: DECSET `?1004` focus reporting + idle fallback on `turn_end`.
- Auto-recap on `/resume` and `/fork`.
- `/recap` command for manual generation.
- Defaults to the user's active model with `reasoning: "minimal"` when supported, for zero-auth-surprise behaviour across built-in and custom providers.
- Flags: `--recap-idle-seconds`, `--recap-focus-min-seconds`, `--recap-disable-focus`, `--recap-disable`, `--recap-model`.
- Draft stamping by branch-leaf id to avoid regenerating on focus-out/in churn without new session activity.
- Idle fallback armed on `turn_end` rather than `agent_end` so errored/aborted turns still get a recap.
- Robust focus-event parser that advances through its buffer so completed sequences never fire twice across chunk boundaries.
- Per-call `AbortController` ownership so late-completing aborted requests can't clear state for a newer in-flight request.
- Quick refocus (< `--recap-focus-min-seconds`) now also cancels any in-flight focus draft, preventing a slow model response from bypassing the suppression.

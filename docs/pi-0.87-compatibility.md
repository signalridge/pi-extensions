# Pi 0.87.1 compatibility and upstream review

Historical snapshot completed: 2026-09-30. This review covers all 27 extensions and two shared libraries against the released Pi 0.87.1 host, not Pi `main`. The current npm `latest` is 0.99.1; see the [0.99.1 compatibility review](pi-0.99-compatibility.md). The earlier [0.85.1 audit](pi-0.85-compatibility.md) and [September 13 upstream snapshot](upstream-refresh.md) are also historical records.

## Released-host changes

At this snapshot, the four root development dependencies (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) targeted 0.87.1. Published Pi peers admitted the 0.84, 0.85, 0.86, and 0.87 minor lines separately: zero-major caret ranges do not cross minor versions. `pi-subagents-protocol` has no Pi dependency and its wire protocol is unchanged.

- [Pi 0.86.0](https://github.com/earendil-works/pi/releases/tag/v0.86.0) requires a normalized `TranscriptContext` at direct provider stream boundaries. `pi-btw` and `pi-codex-compact` normalize when the host offers that API and retain the legacy path for older hosts. Direct calls keep their existing auth endpoint and, for Codex, its SSE payload inspection.
- [Pi 0.87.0](https://github.com/earendil-works/pi/releases/tag/v0.87.0) makes `SessionManager` canonical for provider history and adds context edits and actionable turn boundaries. The hidden mentioned-agent clone seeds the active branch into an in-memory manager and uses a public resource loader for the live prompt; its real SDK test checks compaction, edits, loaded context redaction, Agent-only tools, and main-session attribution. `pi-session-recap` uses Pi's projected context and waits for final settlement rather than a low-level `agent_end`.
- Pi 0.86+ may persist separate `usage` entries (including cache warming). `pi-statusline` and `pi-usage-extension` count them without treating them as assistant messages. `/usage` distinguishes intentional context edits from unexplained cache-prefix misses. Goal's SDK smoke reads the current system message rather than assuming a legacy `context.systemPrompt` field.
- None of these changes calls the removed `shouldStopAfterTurn`, constructs a `turn_end` boundary, or handles `user_bash`; those release-note changes did not require mechanical rewrites here. Existing `agent_settled` ownership remains intentional.

## Latest extension references

Refs were checked against upstream GitHub on 2026-09-29–30; a reference is not an instruction to replace this repository's code or persistence format.

| Reference | Observed ref | Disposition |
| --- | --- | --- |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions/commit/9058c15011ed250e69b89dbd680d785a82deb87d) | `9058c150` | Reviewed Pi 0.86/0.87 host adaptations, recap-related lifecycle patterns, BTW routing, LSP and GitHub PR ownership, statusline usage. Ported only compatible, testable behavior. |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents/commit/e955e29c51b7a6cce37e1108cd2d6c57a77e151c) | `e955e29`, v0.19.0 | Direct fork reference; unchanged since the previous review. Its old `state.messages` path is not a Pi 0.87 migration guide. |
| [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions/commit/4a63a2ebd3683d86597e226c7ff778ea4837dd73) | `4a63a2eb`, session-recap v0.5.1 / usage v0.9.5 | Ported model-visible recap projection and settlement behavior, not the upstream UI/storage as a whole. Reviewed usage accounting. |
| [ouzhenkun/pi-input-history](https://github.com/ouzhenkun/pi-input-history/releases/tag/v1.1.3) | v1.1.3 | Ported the editor redraw after accepting a reverse-search match; kept the local two-pane UI. |
| [QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows/releases/tag/v3.13.1) | v3.13.1 | Reviewed provider-limit classification and bounded recovery, but deferred the port: its pause timers, journal replay and reset-hint edge cases require a separate verified migration. Kept `pi-workflows` orchestration separate from `pi-subagents` execution and its managed RPC/journal. |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents/commit/f34efb13140951fd537ad35f571eb5f39afb4dc3) | `f34efb13`, v0.73.1 | Alternative implementation, not the direct fork; reviewed child skill scoping after extension discovery. |
| [tomsej/pi-ext](https://github.com/tomsej/pi-ext/commit/e132c44b3b06f88f7fcfb67b80c91698d8c1814f) | `e132c44b` | Worktime design reference; no newer relevant commit. |

Claude Code is a **public behavior reference**, not an available source-code dependency: Agent tool naming, mention intent, background-result delivery, plan/read-only expectations and human-readable permission prompts were compared with [its subagent](https://code.claude.com/docs/en/sub-agents) and [permission](https://code.claude.com/docs/en/permissions) documentation. This repository intentionally uses a hidden throwaway turn for model-assisted `@agent` mentions and a separate workflow package; those are not claims of identical internals. Plan mode disables extension tools by default; explicitly opted-in extension tools retain their own execution policy. `ask_tools` approval is session-scoped and the confirmation now says so.

## Package-by-package disposition

A host update means the published peer range and package loader/test suite are in scope; it does **not** assert that every package needed a source change.

| Extension | Review outcome |
| --- | --- |
| `pi-agent-guidance` | Host update; guidance/resource behavior retained. |
| `pi-analytics` | Host update; experimental event-based analytics kept distinct from Pi's persisted cache-warming usage. |
| `pi-ask-user-question` | Host update; RPC/TUI cancellation and unavailable-UI paths retained. |
| `pi-btw` | Provider transcript bridge and model-visible side context, including edited/omitted messages, summaries, custom entries and visible Bash output; the first request refreshes its snapshot. Menu and fullscreen custom UIs close before a committed session/tree transition can restore the old editor over the new branch; canceled transitions preserve the draft. Existing auth routing and bounds remain. |
| `pi-code-actions` | Host update; indexed actions and RPC behavior retained. |
| `pi-codex-compact` | Provider transcript bridge; retained checkpoints fingerprint Pi's edited projection, and opaque compaction falls back to native when the live prompt/tools or session branch diverge from the persisted transcript. SSE recovery retained; experimental. |
| `pi-files-widget` | Host update; session-relative and TUI-only behavior retained. |
| `pi-github-pr` | Nonblocking startup refresh with generation/cancellation ownership. |
| `pi-goal` | Host update and real-SDK smoke adaptation; ordered continuation semantics retained. |
| `pi-gpt-fast` | Host update; provider-specific model allowlist retained. |
| `pi-herdr-state` | Host update; native waiting-span ownership retained. |
| `pi-input-history` | Editor redraw on accepted search match and session-owned asynchronous search; rapid Ctrl+R presses share one popup. A committed tree transition retires the old scan/popup before it can write the new branch's editor; canceled pre-navigation leaves the current draft intact. Local layout retained. |
| `pi-input-prefix` | Host update; editor composition retained. |
| `pi-lsp` | Bound server stderr and clear stale process events, partial JSON-RPC frames and diagnostics on restart; existing diagnostic/mutation queue retained. |
| `pi-plan-mode` | Host update; default read-only built-ins and explicit extension-tool opt-in retained. |
| `pi-ralph-wiggum` | Host update; independent loop state retained. |
| `pi-recall` | Host update; remains opt-in experimental. |
| `pi-session-recap` | Model-visible context projection and settled timing; independent provider calls exclude parent system/tool declarations and revalidate the projection after authentication. Recent-window selection keeps completed tool work without orphan results or aborted turns; blur timers cannot bypass the settlement debounce. |
| `pi-stamp` | Host update; metadata ownership retained. |
| `pi-statusline` | Standalone usage accounting and idle-refresh ownership. |
| `pi-subagents` | Canonical mention clone and bounded projected inherited context, with a compaction-aware fallback for older hosts; session-fenced mention dispatch and streaming cancellation, Pi-matched model-scope resolution, explicit/coalesced approval, and child skill/tool isolation. |
| `pi-tab-status` | Host update; final title still waits for settlement. |
| `pi-usage-extension` | Standalone usage and branch-aware context-edit/cache-warm insight accounting, including concrete response-model aliases, zero-usage warm timestamps, root-fork thinking attribution, and genuine prefix misses. Canonical JSONL lineage and retained edits are indexed/shared rather than replayed quadratically; cache schema v11 rebuilds older records. |
| `pi-welcome` | Host update; one additive startup entry retained. |
| `pi-workflows` | Host update; managed RPC, journal and existing provider-limit recovery retained. A newer upstream retry-policy port was reviewed but deferred after adversarial tests found unresolved restore and scheduling edge cases. |
| `pi-worktime` | Host update; active-span accounting retained. |
| `pi-worktree` | Host update; opt-in repository identity and locking retained. |

Shared libraries: `pi-ui` admits the new host and retains its public TUI adapter; `pi-subagents-protocol` is reviewed but has no Pi peer, published-file change, or wire version bump.

## Verification and limits

The final `bun run check` passed on Pi **0.87.1** with the CI-pinned **Bun 1.3.14**. It covers all 29 package lint/typechecks/tests, release and configuration tests, capability/changeset/version/boundary checks, 27 individual package tarballs, the stable subagent/workflow pair, 24 stable extensions together, pack validation, and secret scanning. Four opt-in live-provider subagent tests were skipped. `bun install --frozen-lockfile` also passed on Bun 1.3.14.

An isolated loader harness using the same packaged-tarball smoke script activated **all 27 extensions independently**, the pair, and all **24 stable extensions together** under each of Pi **0.84.1, 0.85.1, 0.86.1, and 0.87.1** after the source changes. The matrix validates loader and SDK activation, not every feature or provider call on older hosts. Real provider credentials, a physical terminal, external LSP servers, and live GitHub data were not exercised.

A known upstream API limitation remains: `pi-subagents` reads the private `ModelRegistry.runtime` to pass parent provider/auth state into a full child session. Pi 0.87.1's public registry stream helper is not a lossless replacement for this child-session constructor. Do not claim the private access has been removed. The hidden mention clone restores installed context hooks, but a caller's one-off manually supplied extension paths cannot be enumerated through public `ExtensionContext`; such hooks may not be replayed by a fresh loader. `inherit_context` uses the canonical Pi projection before request-local `context` hooks and bounds the combined inherited text, favoring recent context; do not use it as a privacy boundary for hook-only redaction.

A Pi 0.87 navigation limitation remains: a later extension can veto `session_before_switch` or `session_before_tree` after subagents and workflows have quiesced their active work. The host emits no cancellation outcome in that case, and its `session_tree` event runs only after the leaf changes, too late to journal the old branch safely. The partial tree mitigation forwards the unique `session_before_tree` signal through the subagents bus: if a canceled attempt left workflow quiescence pending, a second attempt waits for it and quiesces runs started in between. Bus/native notifications for one attempt still deduplicate; older hosts without the signal retain legacy deduplication. This does **not** undo the first attempt's abort or restore its interrupted runs. A reliable fix requires an awaited post-veto, pre-mutation commit hook in Pi; canceled navigation can still interrupt active child/workflow runs. Do not treat a pre-navigation event as proof that the navigation committed.

A canceled `/usage` scan now returns no result after a cache-save lock wait, but the existing lock timeout can still delay that cancellation by up to five seconds.

The experimental Codex checkpoint checks the active branch and prompt/tool state before and after its remote call, but a different extension's later `session_before_compact` handler can still mutate those after this handler returns and before Pi persists the checkpoint. Keep such handlers ordered ahead of Remote V2 or use Pi's native compaction for that combination. The newer upstream workflow provider-limit scheduler was deliberately not ported after its recovery and timer semantics failed adversarial review; existing local workflow recovery remains in place. `pi-statusline` avoids history copies on unchanged idle ticks, but a tick after the session leaf advances still calls Pi's full `getEntries()`; very long, actively changing sessions can incur repeated history copies. Other earlier upstream candidates, including LSP URI canonicalization and process-exit waiting, remain separate follow-up work rather than untested ports.

# Pi 0.85.1 compatibility audit

## Scope

This audit covers all **29 workspace packages**: 27 extensions (24 stable and three experimental) and two shared libraries. It does not audit third-party packages outside this repository, publish releases, or modify an existing global installation.

The npm `latest` version checked was **0.85.1**; the previous development baseline was **0.84.1**. The old Pi peer range, `^0.84.0`, excludes 0.85.1 under zero-major caret semantics. All 28 Pi-using packages now admit `^0.84.0 || ^0.85.0`, and existing Pi development pins use 0.85.1. `pi-subagents-protocol` has no Pi dependency and needs no host-version change. Experimental packages remain opt-in.

Changesets describe the pending package releases. No cross-package protocol version or existing export was removed.

## Relevant upstream changes and adaptations

Changes since the previous baseline include in-run compaction, session-scoped model selection, an optional PowerShell tool, native UI waiting events, and fullscreen mouse handling. These require more than changing dependency metadata:

- **Compaction:** Goal leaves iteration finalization to the running agent's completion event. Subagents determine the invocation's final error from finalized message events, not array offsets that compaction invalidates.
- **Model selection:** A fresh Plan implementation no longer automatically submits to a different default model. It leaves the request in the replacement editor and explains how to select or confirm the intended model.
- **Mouse input:** Shared bordered components forward mouse events with translated content coordinates. Input-prefix hit-testing accounts for its visually detached shell marker. The standalone working indicator remains unchanged.
- **Waiting state:** Herdr consumes native coalesced UI waiting spans independently of extension-owned blocked counters, without transmitting prompt titles. It remains working through automatic retry delays.
- **PowerShell:** Subagents recognize the optional built-in without changing their historical wildcard defaults. Tab status tracks successful commit-candidate tool results by call ID for both Bash and PowerShell.
- **RPC and tools:** Question cancellation reaches the underlying dialogs. Terminal-only views give explicit RPC feedback; indexed code actions retain their supported RPC paths. LSP fixes join Pi's file-mutation queue, and LSP/file-browser paths follow the session cwd.
- **Workflow context:** Replay reads the executing context's session branch; widgets use the real session UI; foreground checkpoints can use RPC dialogs. Tool abort, pause, stop, disposal, and fatal cancellation close unanswered dialogs without journaling cancelled answers.
- **Regression gate:** Package validation now rejects a Pi peer range that excludes its corresponding exact root-tested Pi version. Identical but incompatible ranges can no longer pass merely because all packages agree.

The audit also considered explicit prompt expansion, built-in-only `defaultTools`, failed-compaction events, in-memory session restoration, and optional embedded editor indicators. These do not justify unrelated feature additions. `ctx.scopedModels` and `registerMarkdownTransformer` already existed before 0.84.1. Unsupported experimental client/plugin npm entrypoints are not used.

Sources: [upstream changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md), [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [TUI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md), and [compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md). Review used installed 0.85.1 artifacts, not assumptions about moving main-branch documentation.

## Package coverage

“Host update” means updated dependency metadata and validation against the new host, with no additional upgrade-specific source change identified.

| Package | Result |
| --- | --- |
| `pi-agent-guidance` | Global guidance/config discovery uses public `getAgentDir()` |
| `pi-analytics` | Host update; remains experimental |
| `pi-ask-user-question` | Abortable RPC selectors and Other input |
| `pi-btw` | Real top-level tool results included in bounded side-question context |
| `pi-code-actions` | Explicit RPC picker feedback; RPC execution output preserved |
| `pi-codex-compact` | Effective compaction-boundary selection permits native-to-remote recovery; remains experimental |
| `pi-files-widget` | Session-relative paths and terminal-mode guards |
| `pi-github-pr` | Host update |
| `pi-goal` | In-run compaction iteration accounting |
| `pi-gpt-fast` | Host update; existing verified model allowlist retained |
| `pi-herdr-state` | Native waiting spans and retry-aware working state |
| `pi-input-history` | Host update |
| `pi-input-prefix` | Shell mouse hit-testing and default-suite regression coverage |
| `pi-lsp` | Shared mutation queue and session-relative roots |
| `pi-plan-mode` | Fresh-session model identity guard |
| `pi-ralph-wiggum` | Host update |
| `pi-recall` | Host update; remains experimental |
| `pi-session-recap` | Host update |
| `pi-stamp` | Tree navigation restores branch timestamps and invalidates abandoned observations |
| `pi-statusline` | Host update |
| `pi-subagents` | Compaction-safe invocation results and optional PowerShell recognition |
| `pi-subagents-protocol` | Reviewed; no host dependency or protocol change required |
| `pi-tab-status` | Shell commit-result ownership, including PowerShell; completion waits for `agent_settled` |
| `pi-ui` | Bordered mouse forwarding |
| `pi-usage-extension` | Explicit RPC dashboard feedback |
| `pi-welcome` | Host update |
| `pi-workflows` | Real context APIs for replay/widgets and RPC foreground checkpoints |
| `pi-worktime` | Host update; documented active-span semantics preserved |
| `pi-worktree` | Host update |

## Verification

Final current-checkout validation with Pi **0.85.1**, including all follow-up fixes:

- `bun run check` passed, including manifest/boundary/version/changeset/capability checks, strict lint, all package typechecks, tests, release/configuration checks, packaging, and secret scan.
- Package test summaries reported **3,208 passed**, with four existing subagent skips. Repository release/configuration suites added **83 passed**. SDK smoke assertions are additional to those test counts.
- Real Pi loader/SDK smoke activated **27 independent package tarballs**, exercised the subagent/workflow pair, and loaded **all 24 stable extensions together**.
- The same tarball/SDK smoke was additionally run with the retained **0.84.1 host** and passed. This is backward runtime verification, not a complete older-host typecheck/test matrix or verification of every 0.84 patch release.
- Public-source compiler fixtures for the mouse adapters passed against both **0.84.1 and 0.85.1** declarations; the new mouse capability does not require newer-only type exports in older consumers.

The initial dependency-only aggregate attempt timed out in the subagent suite; its standalone retry passed. Strict lint caught a test-only non-null assertion, which was fixed. Final review also identified captured-gesture release handling, older-host mouse type compatibility, and unanswered RPC checkpoint cancellation; these were fixed and covered by regression tests before rerunning the complete checks successfully.

Static review covered every package through 12 independent groups. For large orchestration packages, review concentrated on host APIs and lifecycle paths rather than every helper. Mock/SDK tests do not establish live-provider, real terminal, Windows PowerShell execution, external LSP-server, GitHub, or Herdr-server behavior.

## Follow-up finding status

Five bounded findings are now fixed and covered by package regressions:

- `pi-btw`: real top-level `toolResult` text, including diagnostic-only output, is included; images are not fabricated and large output remains truncated.
- `pi-codex-compact`: selection follows Pi's effective compaction boundary rather than resurrecting a historical remote checkpoint. Remote → native → remote recovery works; current model mismatch, malformed details, missing anchors, and broken retained lineage still fall back safely. Provider/authentication transport is unchanged.
- `pi-agent-guidance`: global guidance and configuration use public `getAgentDir()`. Tests isolate both the environment override and normal fallback without global file writes.
- `pi-stamp`: successful in-place tree navigation rebuilds the predecessor timestamp and clears abandoned pending stamps/timings; asynchronous owners are invalidated. Cancelled navigation leaves state intact.
- `pi-tab-status`: low-level `agent_end` caches the final stop reason; only an idle `agent_settled` finalizes the title. Successful commit evidence survives retries and continuations until settlement.

These follow-up edits received affected-package strict lint, typechecks, tests, and source diagnostics. They are now included in the final root check above.

### Final bounded review findings

The four additional confirmed findings are fixed:

- **P1 — Codex retry projection:** version-1 details optionally retain the exact retry-only assistant tail as verifiable proof. Parsing requires assistant `error`/`length` and an exact last-kept fingerprint match. Projection requires explicit full/persisted versus runtime-omitted provenance; fingerprints alone cannot distinguish a new identical retry response from the old persisted occurrence. `session_compact.willRetry` plus validated proof establishes omission; an extension-owned weak handoff keyed by the public session manager preserves it across same-runtime reload, fenced by session identity and checkpoint ID. Fresh sessions, tree rebuilds, and native compaction reset it. Unknown provenance fails closed rather than deleting a potential new response; persisted remote-compaction input explicitly uses full mode. Legacy records without proof remain strict. Tests cover Pi's native context rebuild/runtime trim sequence, persisted resume, later assistants, multiple checkpoints, malformed/user-tail proof, missing anchors, missing earlier messages, and model mismatch. Native provider/authentication transport is unchanged.
- **P2 — BTW allocation bound:** newest-first traversal stops at the suffix budget without mutating the branch; individual blocks and JSON-shaped arguments are sliced/serialized within the remaining budget before joins. Wide objects retain only budget-bounded own-enumerable suffix keys in a circular buffer, not a full `Object.keys` array. Enumeration remains linear and VM-internal allocations are not claimed to be bounded. Tests use 12,000 real-shaped results sharing a 50,000-character string, throwing older-content getters, oversized blocks/arguments, and exact ordinary/truncated output comparisons.
- **P2 — Herdr event ordering:** signed native start/end balance retains unmatched-end debt independently of manual blocked counters and resets on session ownership/disposal. A real `ExtensionRunner` regression delays a preceding start listener while an immediately dismissed dialog emits its end. Normal spans, manual overlap, idle prompts, ownership reset, and title privacy remain covered.
- **P2 — Workflow foreground cancellation:** execution guards and cancellation classification use the execution signal, including the foreground invocation. After confirmed cleanup, tool cancellation settles as `interrupted`, permits fresh `workflow_control` resume, and does not claim the run continues. Foreground return waits for execution and exact-owner quiescence after the stop RPC acknowledgement, not merely the acknowledgement itself. Cancel-before-spawn-ack paths reconcile the allocation and await the same cleanup. Missing, negative, rejected, or timed-out quiescence writes an existing terminal-recovery fact with a non-resumable stop diagnostic; pause/resume cannot dispatch replacements during cleanup. Cleanup RPCs do not inherit aborted turn/session signals. Background invocation and waiter cancellation remain detached. Tests cover unanswered confirm/input/select cancellation, successful control resume, gated agent cleanup, and no cancelled-answer journals, alongside pause/stop/disposal/fatal/root-abort coverage.

These four packages passed strict lint, typechecks, complete package suites (**510 tests**), and source syntax diagnostics during this bounded follow-up. The full root check was subsequently rerun after all corrections. The additional changeset uses patch releases because these are bug fixes; the optional version-1 proof is backward-compatible and no cross-extension protocol changed.

### Latest three review corrections

The occurrence ambiguity, stop-acknowledgement/quiescence distinction, and wide-object key allocation findings above are **FIXED** in this bounded follow-up. Regression coverage includes identical cloned error/length messages, extension lifecycle reload/rebuild sequences, immediate stop acknowledgement with delayed cleanup (including cancellation before the spawn reply), unsuccessful cleanup with journal restoration, and 120,000-key JSON-shaped objects sharing an oversized final value. All three packages passed strict lint, typechecks, and complete suites: Codex **53**, BTW **156**, workflows **297** (**506 total**). All five changed source modules passed syntax diagnostics. Workflow regressions also exercise the real event-bus RPC client with immediate stop acknowledgement, delayed quiescence replies, and an already-aborted session signal. The existing packaged SDK smoke and full root check were subsequently rerun on the final current checkout; no new live-provider smoke scenario is claimed.

A further workflow-only correction treats exact-owner quiescence as authoritative even when a duplicate stop rejects after spawn reconciliation already marked the child stopped, or the stop method is unavailable. The real RPC-client spawn-race regression holds foreground return and resume until an explicit cleanup gate, then verifies interruption and successful resume. Existing timeout, unsuccessful-quiescence, and durable recovery tests remain intact. Workflow strict lint (32 files), typecheck, all **300 tests** across **13 files**, and source/test syntax diagnostics passed. The full root check and existing packaged SDK smoke were then rerun successfully.

## Remaining upstream limitation — explicitly UNFIXED

`pi-subagents` still accesses the private `ModelRegistry.runtime` in its runner and mention clone. Pi 0.84.1/0.85.1 provides no equivalent public runtime accessor. A fixed-model bridge through public providers is possible, but is not a transparent replacement for model-specific headers, arbitrary model selection, parent authentication overrides, cancellation, and provider state. Replacing the existing path with that approximation would change supported behavior. The access is therefore retained, not reported as fixed; removing it requires an upstream API or an explicitly approved behavior change. Passing current-version smoke tests does not eliminate this future compatibility risk.

## Investigated non-defect

The TypeBox peer concern was independently refuted: extensions can resolve their `^1.3.11` peer while Pi resolves its separate 1.3.7 dependency. Both versions coexist in the tested graph, and Pi's loader aliases runtime schema imports to the host. This is not an automatic Pi 0.85.1 installation conflict, so no unvalidated peer-floor reduction was made.

No broad provider/authentication changes, new standalone packages, or unverified model-priority support were added.

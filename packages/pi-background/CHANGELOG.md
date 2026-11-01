# Changelog

## 1.7.0
### Minor Changes

- da9ed0f: Remove the cooperative launch review for the retired `@signalridge/pi-approvals` extension. `bash_background` and command-starting `monitor` no longer look for a human approval service or advertise an approval adapter, and the package no longer depends on `@signalridge/pi-approval-core`. Launch inputs are still revalidated against the registered schema and frozen before dispatch. Permission extensions that gate `bash` must keep covering `bash_background` and `monitor` explicitly.

### Patch Changes

- da9ed0f: Stop process events from waking a session whose context overflowed the model window. While the latest response on the branch is a context overflow with no compaction after it, `notify: "turn"` events are added to the conversation as context without starting a turn, and one warning per overflow episode asks to run `/compact` (or `/codex-compact` when installed) or start a new session. A compaction or a later successful response restores normal wakes. Previously each wake resent the same over-window context and failed again. The package now declares `@earendil-works/pi-ai` as a host peer dependency.
- da9ed0f: - Reject rename hardlink aliases and retargeted queue identities before writes; support all LSP newline styles and identify possibly partially modified targets on write failure.
  - Fence pending physical Plan model mutations at cancellable navigation/replacement gates, reconcile handoffs by native selection chronology, and scope thinking-only restoration to its originating model.
  - Compose Goal guidance through an owned structured prompt section. Resolve overflow usage against physical response models and invalidate stale size evidence after persisted context edits in each independent continuation helper.
  - Persist queued Rules reminders/offers only at authenticated native admission, match file URL paths, and provide usable rule-file references when read_rule is unavailable.
  - Inherit nested workers' thinking from their immediate spawning session while preserving explicit policy precedence.
  - Refresh skill discovery for custom Analytics runs without consuming pending user attribution, and finalize successful Codex diagnostics only after UI cleanup and the final owned result fence.

## 1.6.1
### Patch Changes

- c639660: Keep pending completion reminders cancellable until parent boundaries and consume deliberately read terminal results instead of replaying stale notifications.
  
  Subagents selectively adapt tintinweb/pi-subagents #388's completion outbox, merge eligible batches into one steering message, and retain explicit groups, attempt ownership, and Claude Code notification XML. Successful terminal result reads suppress that attempt's pending reminder; unread failures remain eligible.
  
  Background terminal log or explicit-ID status reads consume only exit notices, preserving unread monitor matches and future completion after running reads. Workflow get/status adds explicit `consume: true` with a branch-visible acknowledgement receipt, without consuming ordinary inspections or suppressing resumed executions. Already accepted transcript messages and historical results remain unchanged.
  
  Stopped workflow state retains the accepted terminal event timestamp across slow appends and restore. Background reads prepare job data before committing exit consumption, and post-commit status-rendering failures cannot turn a successful read into an error. Early smart-group completions retain finalized membership separately from immutable results, with partial-group labels rechecked at handoff.

## 1.6.0
### Minor Changes

- a4dc1de: Add a compact description-first shell-job roster and scrollable overview before logs, preserving selection and viewport through back navigation. Honor native selection keybindings, clear vanished selections before activation, and refresh elapsed labels only while a mounted view needs them. Direct `/background view <id>` log entry and bounded sanitized log snapshots remain supported.

## 1.5.0
### Minor Changes

- 0ec64d1: Gate background shell and command-form monitor launches through a captured human approval service when present. Revalidate and freeze final execution inputs, retain exact session ownership across approval waits, and advertise schema-bound cooperative approval support. Existing-job monitors and inspection/control tools remain ungated.
- 0ec64d1: Add a Ctrl+Alt+B native-editor shortcut to the existing owned background task selector, with a compact keyboard-entry hint in retained-job status. Commands and shortcuts share the same guarded task UI, stop/cancel behavior, and retirement cleanup; focused dialogs and existing viewers retain input ownership.

### Patch Changes

- 0925139: Bound synchronous file-review diff work before generation, capture bash execution options and environments, require exact per-name canonical review bindings, and close owned review overlays by identity. Recheck cooperative adapter admission after child tool-call normalizers and carry the same captured approval-service and branch-owner guard through background startup to command dispatch. Preserve existing v1 approval and v4 managed contracts; document review limits and trusted-extension boundaries.
- Updated dependencies [74b65a5]
- Updated dependencies [0ec64d1]
- Updated dependencies [0925139]
  - @signalridge/pi-approval-core@1.3.0

## 1.4.0
### Minor Changes

- 1170952: Add explicit, live `/background` task and `/background view <id>` log screens with stable selection, bounded terminal-safe rendering, scrolling/follow-tail, stream filtering, and captured-ID stop/clear confirmations. Release view subscriptions on close or session retirement and retain tools/snapshots without custom UI in RPC/headless modes. Encourage proactive background execution for long builds/tests with independent work, while preserving regular bash for immediate dependencies and event-driven completion without polling.

## 1.3.0
### Minor Changes

- c2fd867: Add an opt-in experimental package for session-owned background shell jobs and low-noise literal log monitors, with bounded process/log ownership, graceful termination, coalesced idle notifications and explicit recovery.
  
  Report shell results before inherited pipes close, drain through descendant cleanup without charging grace to command deadlines, and fence tool/delivery/ACK updates by the live session manager and branch prefix. Navigation preflight (including fork) retains jobs and pending notices on cancellation for explicit retry. Preserve exact literal whitespace and sanitize DCS/C1/fragmented terminal-control excerpts without altering retained decoded logs.

## 1.2.0

- Initial experimental background shell and literal log-monitor implementation.
- Session-owned process groups, bounded logs/history, controlled exit/match notifications, explicit stop and recovery tools.

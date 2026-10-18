# Changelog

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

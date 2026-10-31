---
"@signalridge/pi-subagents": minor
"@signalridge/pi-background": patch
"@signalridge/pi-workflows": minor
---

Keep pending completion reminders cancellable until parent boundaries and consume deliberately read terminal results instead of replaying stale notifications.

Subagents selectively adapt tintinweb/pi-subagents #388's completion outbox, merge eligible batches into one steering message, and retain explicit groups, attempt ownership, and Claude Code notification XML. Successful terminal result reads suppress that attempt's pending reminder; unread failures remain eligible.

Background terminal log or explicit-ID status reads consume only exit notices, preserving unread monitor matches and future completion after running reads. Workflow get/status adds explicit `consume: true` with a branch-visible acknowledgement receipt, without consuming ordinary inspections or suppressing resumed executions. Already accepted transcript messages and historical results remain unchanged.

Stopped workflow state retains the accepted terminal event timestamp across slow appends and restore. Background reads prepare job data before committing exit consumption, and post-commit status-rendering failures cannot turn a successful read into an error. Early smart-group completions retain finalized membership separately from immutable results, with partial-group labels rechecked at handoff.

---
"@signalridge/pi-workflows": patch
"@signalridge/pi-subagents": patch
"@signalridge/pi-herdr-state": patch
"@signalridge/pi-tab-status": patch
"@signalridge/pi-ui": patch
"@signalridge/pi-files-widget": patch
---

- Bound workflow cancellation drains and durably fence unconfirmed cleanup, aborting sibling agents and releasing foreground callers.
- Await managed timeout cleanup before script continuation and terminal publication.
- Keep failed retry text and length responses discarded by overflow-compaction retry out of successful subagent fallbacks, while retaining valid pre-compaction and non-retried length output.
- Account for native prompts spanning reporter activation without dropping out-of-order wait debt.
- Reconcile settlement after observer-triggered manual compaction with run/session ownership.
- Preserve clipped overlay hit ranges and native container ancestry for editor autocomplete focus.
- Reconcile errored writes and edits against pre/post mutation evidence, retaining invocation cwd and releasing evidence when blocked or aborted preflight bypasses tool results.

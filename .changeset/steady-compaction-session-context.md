---
"@signalridge/pi-goal": patch
"@signalridge/pi-subagents": patch
"@signalridge/pi-workflows": patch
---

Keep goal iteration and continuation numbering correct when Pi compacts between tool results and the next response within one run. Preserve existing response limits and manual/post-run compaction handling.

Capture subagent invocation results from finalized assistant events with bounded message retention so compaction cannot hide a final error or mix in historical output. Recognize explicitly selected PowerShell when the host provides it, without requiring its export on older Pi versions or expanding default wildcard tools.

Use real session contexts for workflow replay and live TUI progress, release widget bindings on shutdown, and allow foreground checkpoint dialogs in RPC mode while retaining print-mode defaults. Cancel unanswered dialogs with their owning execution on tool abort, pause, stop, disposal, or fatal failure without journaling cancelled answers.

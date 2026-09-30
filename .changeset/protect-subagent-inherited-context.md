---
"@signalridge/pi-subagents": patch
---

Maintain a projection-aware parent-context formatter that respects persisted context-edit omissions, replacements, and compaction boundaries; older hosts use resolved session context instead of raw pre-compaction branch entries. The formatter is not dispatched by the current child runtime because Pi does not expose request-hook-redacted context or an atomically pinned child destination; automatic inheritance now fails closed.

---
"@signalridge/pi-subagents": patch
"@signalridge/pi-workflows": patch
---

Retain Pi's tree-navigation attempt signal for branch ownership and deduplication. Active child or workflow work now causes a non-destructive preflight veto rather than pre-veto quiescence; accepted tree changes fence late old-branch callbacks. A second attempt rechecks live work instead of reusing state from a canceled attempt. Pi still lacks an atomic post-veto, pre-leaf commit hook: work started during asynchronous summarization may need to be quarantined on commit.

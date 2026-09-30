---
"@signalridge/pi-btw": patch
---

Normalize side-thread requests before calling Pi 0.87 providers while retaining legacy Context requests on older Pi hosts and preserving the auth-resolved endpoint. When a question explicitly opts in to unfiltered parent history, build its snapshot from Pi's session projection (which honors persisted edits but not request-time privacy hooks), refresh it when the first provider request starts so intervening edits are honored, then keep that snapshot for follow-ups. Fence stale session requests and bring-to-main actions, include bounded compaction and branch summaries plus model-visible custom/Bash messages in order, and retain the raw-branch fallback on older Pi hosts.

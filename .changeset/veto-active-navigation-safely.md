---
"@signalridge/pi-subagents": patch
"@signalridge/pi-workflows": patch
---

Block session switches and tree navigation while subagents, workflows, or provider cleanup remain unsettled, without stopping work on a cancellable attempt. Confirmed shutdown coordinates workflow-owned cleanup before retiring the subagent RPC responder; confirmed tree changes fence stale callbacks and keep old terminal facts off the new branch. Pi's hook ordering still leaves a narrow, non-atomic interval between preflight and commit, so new work during summarization is quarantined on commit rather than guaranteed to finish.

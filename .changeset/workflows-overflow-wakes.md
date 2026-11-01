---
"@signalridge/pi-workflows": patch
---

Stop settled workflow results from waking a session whose context overflowed the model window. While the latest response on the branch is a context overflow with no compaction after it, results are still delivered and acknowledged as context but no wake is sent, and one warning per overflow episode asks to run `/compact` (or `/codex-compact` when installed) or start a new session. A compaction or a later successful response restores normal wakes. Previously each wake resent the same over-window context and failed again. The package now declares `@earendil-works/pi-ai` as a host peer dependency.

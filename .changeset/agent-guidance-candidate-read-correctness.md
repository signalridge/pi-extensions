---
"@signalridge/pi-agent-guidance": patch
---

Validate subdirectory guidance candidates on their real paths before reading, rejecting files outside the working directory or in dependency trees while retaining in-tree symlink deduplication. Only record an unparameterized read as complete when its result is not automatically truncated, leaving incomplete guidance eligible for subsequent bounded delivery.

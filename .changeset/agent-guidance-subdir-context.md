---
"@signalridge/pi-agent-guidance": minor
---

Deliver context files from subdirectories. When the agent reads, edits or writes a file below the working directory, the context files of the directories in between — the file Pi would select there plus the current model's provider file — are appended once to that tool result. Delivery is derived from the current session branch, so compaction, `/tree` and resume redeliver exactly what the model can no longer see. Files are capped at 16 KiB each and 32 KiB per turn, `node_modules` and paths outside the working directory are skipped, and nothing is delivered in an untrusted project. On by default; disable with `"subdirectoryContext": false` in `agent-guidance.json`. Adapted from default-anton/pi-subdir-context `c63f487` (MIT).

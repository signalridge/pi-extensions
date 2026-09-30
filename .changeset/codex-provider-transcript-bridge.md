---
"@signalridge/pi-codex-compact": patch
---

Normalize Codex compaction requests for Pi 0.87 providers without prepending a duplicate system prompt or restoring removed tools when the session already carries system updates; retain the original context path on older Pi hosts. Fall back to native compaction if live prompt or tool changes have not yet reached the persisted transcript, or if the prompt, tool set, or active session branch diverges while the remote request is in flight. Fingerprint only the projected conversation messages Pi actually retains after compaction: system updates are snapshotted onto the compaction entry, while context-edited replacements and raw cut-point identities still replay correctly across repeated compaction and reload.

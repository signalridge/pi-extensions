---
"@signalridge/pi-subagents": patch
---

Resolve restrictive subagent extension policies before Pi loads extension factories, so an excluded discovered extension cannot replace a selected Pi 0.99 built-in. Preserve host-disabled built-ins and explicit source priority; report missing sources or changed settings instead of silently dropping a requested extension.

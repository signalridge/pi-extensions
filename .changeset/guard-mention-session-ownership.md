---
"@signalridge/pi-subagents": patch
---

Discard pending off-screen agent mentions when their originating session or branch is replaced, including direct fallback after a failed clone; abort a hidden provider stream that remains active after replacement. Record the background spawn before UI and event updates so a post-spawn error cannot start a duplicate agent, while pre-spawn failures still fall back directly.

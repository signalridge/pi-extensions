---
"@signalridge/pi-subagents": patch
---

Clarify that approving an `ask_tools` prompt allows subsequent calls to that tool for the whole child session, including resumed turns. The confirmation now names that scope rather than implying approval is limited to the displayed call, and parallel first calls share one approval decision instead of presenting contradictory dialogs.

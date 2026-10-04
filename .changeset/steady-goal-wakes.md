---
"@signalridge/pi-goal": patch
---

Wake waiting goals only after real input is accepted, exclude unrelated usage from their budgets, preserve cumulative usage across compaction and session-tree navigation, and restore deadline timers across pause, resume, and queue transitions. Recheck overdue waits without overriding restrictive tool policies, reset safety only for delivered input, and reduce repeated goal-binding context.

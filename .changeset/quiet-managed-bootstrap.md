---
"@signalridge/pi-workflows": patch
---

Yield before live agent dispatch so synchronous managed-spawn setup cannot be interrupted by the script bootstrap watchdog before promise tracking is attached. Preserve lexical call identity and reservations, check cancellation after yielding, and retain the 1000ms script watchdog. Add real Node process regressions for slow setup, runaway scripts, and pending-spawn cleanup.

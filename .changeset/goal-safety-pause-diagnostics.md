---
"@signalridge/pi-goal": patch
---

Report safety-pause causes and current count/limit before ambiguous ownership errors in Goal tools, and include an authoritative request-local pause notice when background notifications trigger ordinary conversation. Keep ownership, stale-ID, and abort guards intact: notifications never reset counters or bypass a safety pause, and only explicit resume restarts the Goal.

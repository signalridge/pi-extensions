---
"@signalridge/pi-subagents": patch
---

Extract atomic agent-file mutations and cooperative locking into a lightweight Node-only module so cooperating workers can start without loading the SDK. Preserve the existing exports and mutation behavior, including lock bounds, ownership checks, permissions, and recovery files.

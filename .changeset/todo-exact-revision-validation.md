---
"@signalridge/pi-todo": patch
---

Reject fractional or unsafe revision arguments before native integer coercion can turn them into a valid optimistic-concurrency revision. Preserve exact integer-string conversion, runtime graph/revision checks and persisted snapshot schemas.

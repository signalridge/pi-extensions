---
"@signalridge/pi-usage-extension": patch
---

Count Pi 0.87 standalone usage under its model without inflating assistant turns. Classify cache-warm TTL, context edits, compaction, prior assistant context, and thinking levels by journal ancestry rather than append order; edits to entries discarded by compaction no longer hide real prefix misses. Preserve ancestry across large JSONL entries, including valid leading whitespace. Rebuild v9 and older usage caches to retain branch metadata.

---
"@signalridge/pi-codex-compact": patch
---

Accept a remote compaction whose single item is repeated in the completed response with its keys in a different order. Duplicate detection now compares items with keys sorted at every depth, so a valid compaction no longer fails as "2 distinct compaction items". Adapted from narumiruna/pi-extensions `6b89b6ab`.

---
"@signalridge/pi-workflows": patch
---

Skip the full Pi session-branch scan when the workflow journal's anchored leaf is still current. Keep the existing ancestry check when the leaf changes or cannot be reported, so navigated-away branches cannot receive old journal entries.

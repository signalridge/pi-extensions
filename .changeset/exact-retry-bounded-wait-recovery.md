---
"@signalridge/pi-codex-compact": patch
"@signalridge/pi-btw": patch
"@signalridge/pi-herdr-state": patch
"@signalridge/pi-workflows": patch
---

Preserve Codex opaque checkpoints across Pi's retry-only assistant-tail removal using optional, fingerprint-verified version-1 proof plus explicit lifecycle provenance. Preserve that provenance across same-runtime reload without confusing a new identical assistant response with the persisted tail; persisted rebuilds reset it and unknown provenance fails closed. Bound BTW context and tool-argument construction, including suffix-key storage for wide JSON-shaped objects (enumeration remains linear). Balance out-of-order native UI waiting notifications without affecting manual blocked ownership. Foreground workflow cancellation waits for exact-owner quiescence even when stop is unavailable or rejects after reconciliation already stopped the child, including cancelled spawn allocation recovery; unconfirmed cleanup becomes durably non-resumable with a diagnostic retaining any stop error. Background execution remains detached.

These are corrective changes: existing checkpoint fields, exports, and cross-extension protocols remain compatible, so no protocol or major-version bump is required.

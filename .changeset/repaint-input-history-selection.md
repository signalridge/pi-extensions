---
"@signalridge/pi-input-history": patch
---

Repaint the editor after accepting a Ctrl+R history match so the selected prompt appears immediately when the overlay closes. Queue repeat Ctrl+R presses during history loading as bounded moves to older matches without opening another popup, and close active searches or pending scans on session switch or shutdown so pending shortcuts settle without updating a new editor. Retire active searches on committed session-tree navigation as well, without discarding the reusable cross-session scan or cancelling searches for a navigation that was only proposed.

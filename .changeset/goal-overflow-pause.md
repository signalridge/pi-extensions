---
"@signalridge/pi-goal": patch
---

Block a goal with actionable advice when its context overflows the model window. An overflow that Pi's compact-and-retry did not recover now says the context exceeds the model's window and to run `/compact` (or `/codex-compact` when installed) or start a new session, then `/goal resume`, instead of a generic retries-exhausted message. A response that silently exceeds the window (usage above the context window, no error) blocks the same way instead of starting another continuation into the same request. A due `goal_wait` stays paused while the context is overflowed, with one warning, and wakes after a compaction.

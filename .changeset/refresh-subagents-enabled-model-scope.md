---
"@signalridge/pi-subagents": patch
---

Resolve enabled model scope against the current registry on every check instead of reusing an allowed set across projects or availability changes. Honor Pi's bare names, glob patterns, and thinking-suffixed model references in addition to exact IDs, including its provider-qualified partial matching and thinking-suffixed glob precedence. Malformed entries cannot erase a configured project scope, and a list with no available matches now refuses caller-supplied model choices instead of disabling the opt-in scope guard; pinned and inherited models retain their warning policy.

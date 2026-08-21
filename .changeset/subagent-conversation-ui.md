---
"@signalridge/pi-subagents": minor
---

Improve the subagent conversation viewer with a full Pi-style box border, upstream-aligned layout, and height-safe chat controls. Running agents can chat in the viewer, while `steer_subagent` and `@handle message` queue messages safely for queued runs; `/agents` can stop a queued run before it has a session, and cancelled queued resumes no longer leak messages or transcript subscriptions into later resumes.

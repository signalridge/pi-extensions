---
"@signalridge/pi-workflows": minor
"@signalridge/pi-subagents": minor
"@signalridge/pi-subagents-protocol": minor
---

Complete the managed workflow parity and hardening pass. Workflows now forward and validate exact model/thinking, toolset, denylist, thread, and per-call worktree intent while pi-subagents remains the policy and lifecycle owner. Script resume accepts edited revisions, workflow removal is durable, stale lifecycle events are rejected, provider-limit errors pause runs, and the live progress/effort/trigger settings are persisted and bounded. Run identity is durable before dispatch, pause/dispose stop owned agents and reject waiters, and every background start/resume delivers its result. The protocol adds only optional fields and capability metadata, preserving older policy-free managed-spawn consumers; workflows fail closed with a diagnostic when the peer does not advertise managed policy support.

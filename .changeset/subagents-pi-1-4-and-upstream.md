---
"@signalridge/pi-subagents": minor
---

Requalify on Pi 1.4.0 and port upstream fixes.

- Fix: on Pi 1.2 and later, a message typed while a subagent-question wake was starting aborted the wake and left the message unanswered (TUI: returned to the editor; SDK/RPC: recorded but never answered, or stuck in the follow-up queue). Only idle input now invalidates the wake, and queued steering joins the request as an ordinary turn.
- Fix: with `scopeModels` enabled, subagent spawns refused models that Pi 1.4's own `enabledModels` scope admits, such as provider-qualified partials (`anthropic/sonnet`) and IDs offered by several providers.
- Fix: untiered subagents inherit the parent session's thinking level, including `off`, instead of Pi's default.
- Fix: `get_subagent_result` answers from the latest saved record on the branch after the live record is cleaned up or lost to a reload; foreground resumes save their outcome.
- Fix: append-mode agents no longer receive the parent's skill list, cwd and extension sections a second time, and a `skills: false` agent no longer sees the parent's skills.
- Fix: agent files accept Claude Code tool names (`Read`, `Glob`, `MultiEdit`, …) and the `disallowedTools` key.
- Fix: the exploration guideline names Explore only when it can be spawned.
- Fix: a FIFO or other non-regular file named like a memory, skill or agent file is skipped instead of hanging Pi.
- Removed: cooperation with the retired `@signalridge/pi-approvals` service (reviewed child edit/write/bash and adapter-required blocking) and the `@signalridge/pi-approval-core` dependency. `ask_tools` timing, Plan policy, project trust and child tool admission are unchanged.

Upstream: tintinweb/pi-subagents `4fe1877f`, `00de0cd9`, `15464f3b`, `5c81f518`, `f42173ff`; nicobailon/pi-subagents `b09eb5e8`.

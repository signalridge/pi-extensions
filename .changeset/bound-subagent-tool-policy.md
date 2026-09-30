---
"@signalridge/pi-subagents": patch
---

Respect Pi's `exposure` and `defaultActive` settings when exposing child extension tools, without reactivating tools deliberately disabled during a later turn. Bound selected extension `tool_call` handlers, including late registrations and nested tool calls, under a shared per-call deadline while preserving `pi.on` unsubscription; interactive `ask_tools` confirmation remains unbounded until the human responds. A timed-out hook returns a blocked result but cannot cancel side effects that continue after the Promise race.

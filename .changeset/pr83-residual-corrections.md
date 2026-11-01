---
"@signalridge/pi-lsp": patch
"@signalridge/pi-plan-mode": patch
"@signalridge/pi-rules": patch
---

Avoid nested native rename queues across asynchronous key resolution; preflight all targets, then recheck and write one queued target at a time with accurate partial-progress reporting. Reject model handoff mutations when a public session operation is already busy, preserve retry ownership, and conservatively migrate legacy handoffs without a native publication boundary. Match Pi's exact lowercase `file://` recognition while keeping other spellings literal.

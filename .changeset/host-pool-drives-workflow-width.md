---
"@signalridge/pi-subagents-protocol": minor
"@signalridge/pi-subagents": minor
"@signalridge/pi-workflows": minor
---

A workflow now runs at the width of the host's subagent pool rather than a
number it picked blind, and stops charging queue time against the agent waiting
in it.

Two facts were missing on the pi-workflows side, and they compounded. It had no
way to learn `maxConcurrent`, so its own width was a constant guess. And a
dispatched agent was treated as a running one, though a managed spawn takes a
background slot like any other and waits when the pool is full, so a batch
dispatched behind a busy pool could fail as timeouts with none of it having run.

- The ping reply can now carry the peer's live `maxConcurrent`, and pi-workflows
  makes it both the default width and the ceiling: an unnamed `concurrency` takes
  the pool size, and a named one is clamped to it, with the clamp recorded in the
  run log so a caller who asked for a number learns why it got another. It is
  read at each start and resume rather than frozen onto the run, because the pool
  is a setting the user can change in between. One setting therefore governs the
  whole fleet, which is what the ownership boundary already said and what the
  code can now honour.
- **This narrows the common case, and that is the point.** The pool defaults to
  4 background slots, so a default pair now runs a fan-out four at a time where
  it used to dispatch `hardwareConcurrency - 2`. Nothing runs slower for it —
  dispatching twelve into four slots only ever queued eight, ahead of the host's
  own spawns — but the width a run reports is now the width it actually has, and
  `maxConcurrent` is the single place to raise it for workflows and every other
  background agent at once. A host that had already raised it gets the wide
  fan-outs its setting always implied.
- The field is **requested by name** (`include: ["maxConcurrent"]`) rather than
  volunteered. A ping envelope is parsed with `rejectUnknownKeys`, so a peer that
  simply added a field would make every already-published caller reject the
  handshake and lose workflows entirely. Asking keeps both directions working: an
  older peer answers without it and the caller falls back to 16, and a caller that
  never asks gets the v4 envelope unchanged. No version bump, no capability, no
  lockstep release. Both READMEs document the mechanism, since `include` is now
  part of the public cross-extension contract.
- `agentTimeoutMs` now counts from the moment the host reports the agent left its
  queue. The clock is still armed at dispatch and restarted on that report, not
  armed only by it, so a report that never arrives degrades to the old behaviour
  rather than to an agent that can hang forever. A report that arrives *after* the
  agent settled is ignored, so a late or duplicate one cannot leave a live timer
  behind to abort a finished agent.

The engine already subscribed to `subagents:started` and already filtered it by
workflow owner, so the start signal is the event it was discarding.

`getMaxConcurrent` is required on the RPC bridge rather than optional. The other
bridge members are capabilities, advertised in the ping and rejected outright
when missing, so forgetting one fails loudly; a missing pool size has no
capability bit and no failure — the caller would silently fall back to its own
guess and run at the wrong width. Required is what makes that omission a compile
error instead of a quiet wrong answer.

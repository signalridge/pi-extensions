---
"@signalridge/pi-workflows": minor
---

Stop the run's own limits from being the thing that keeps a fan-out small.

Every execution limit a caller can pass — `maxAgents`, `concurrency`,
`agentRetries`, `tokenBudget`, `agentTimeoutMs` — reached the model as a bare
number with no stated default, while the authoring skill asked it to "set finite
bounds that match the work" for three of them. The result was a caller that
priced the run before writing it: fan-outs of one to eight, `concurrency: 1`,
and per-agent wall clocks of two to five minutes. Each of those values ends a run
rather than shaping it — `AGENT_LIMIT_EXCEEDED` partway through, or a whole
batch failing as timeouts — so the precaution removed coverage and not cost.

Four changes, and the first two matter most:

- Every numeric tool input now states its default and says to omit it, and the
  guidelines ask for a fan-out sized to the evidence the task has: one agent per
  independent question, ten to thirty for an ordinary review or audit. The gain
  named is coverage, not speed — one agent asked one question reads further into
  it than one agent asked four — because how many of them run at once is the
  host's pool and not the script's to decide. The authoring and review skills no
  longer treat the invocation limits as the place to express a bound — that
  belongs to the script's own task counts, loop rounds, and fan-out widths, which
  is where the topology is decided. `lifecycle.md` also stops citing two settings
  keys that never existed (`defaultAgentTimeoutMs`, `defaultTokenBudget`).
- `agentTimeoutMs` defaults to 30 minutes rather than 5. It exists to bound a
  hang; an agent's real budget is the turn, tool and token ceiling pi-subagents
  applies to it, which a deep call legitimately spends over many minutes. A
  default an order of magnitude under that budget turned every wide fan-out of
  real work into a batch of timeouts. `null` still removes the wall clock.
- Concurrency defaults to 16 and clamps at 64, up from a default of
  `hardwareConcurrency - 2` clamped at 16. Core count was the wrong quantity: a
  dispatched agent is a remote call this process waits on, so the old default
  fanned a 14-core host out 12 ways and a 4-core host 2 ways for identical work.
  pi-subagents' `maxConcurrent` remains the authoritative throttle — this is the
  guard against a runaway script, and a host that wants a narrower fleet still
  narrows it in one place for every agent it runs.
- `strength` gains a criterion instead of three bare words. `high` now means a
  step whose error is expensive to reverse — an architecture decision, a
  destructive migration, a security boundary — normally absent from a fan-out and
  at most one closing step, and the authoring skill and review checklist both say
  so. The ULTRA effort directive stops asking for it outright: it used to end
  `give the deepest steps strength: "high"`, which priced every branch of a wide
  run at the cost of the one that mattered, and now points the exhaustiveness at
  width and reserves `high` for a step that has that property, if the run has one.
  Nothing about the mechanism changed — there is still no default strength, and a
  call naming none still dispatches with no tier.
- `/workflows run` plans up to 24 tasks instead of 8. The planner's JSON schema
  was the only bound on the one path where the model decides the width itself,
  and 8 was below what an ordinary audit decomposes into. The synthesis step
  absorbs the extra tasks by shrinking its per-worker excerpt: measured against
  the 78,000-character context budget, 8 tasks contribute about 6,000 characters
  each and 24 contribute about 2,500 — three times the coverage at roughly 40%
  of the depth per worker, and about a quarter more total evidence reaching the
  synthesizer. Widening past that would need a larger budget, which the wire's
  100,000-character prompt cap does not leave room for.

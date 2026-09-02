# Lifecycle, limits, and resume

## Bounds and budget

Bound the work where the work is decided: graph tasks, fan-out items, loop rounds, semantic retries, and evidence size, all inside the script. The invocation-level limits are not that place. `maxAgents` (1000), `concurrency` (the host's pool, and 16 only when it publishes none, clamped either way to 64), `agentRetries` (0) and `agentTimeoutMs` (1800000ms, `null` to disable) are tuned defaults, and `tokenBudget` is unlimited unless set; each one stops or fails a run that outgrows it, so a precautionary value removes coverage rather than cost. Pass one only when the user asked for that limit — a `maxAgents` under the script's own dispatch count ends the run with `AGENT_LIMIT_EXCEEDED` partway, and an `agentTimeoutMs` shorter than the host's turn/tool/token budget fails a whole fan-out as timeouts. A journal replay is logical work and does not consume the real-dispatch `maxAgents` cap, but it still counts toward reported call totals. If the user does ask for a token cap, allow for every planned agent call, retry, synthesis, and verification pass, with headroom: a tight gate terminates coverage and does not reduce work already in flight.

`concurrency` needs no value at all: it defaults to the host's pi-subagents `maxConcurrent`, read live at each start and resume, and a larger request is clamped to it (the run log records the clamp). Dispatching wider would not run wider — a workflow agent takes one of those background slots like any other, so the surplus would only wait in the host's queue, ahead of the host's own spawns. Name a number here only to run *narrower* than the host allows, and only when the user asked for that.

That pool is typically small — 4 slots unless the host was configured otherwise — so assume a wide fan-out runs in waves, not all at once. This does not change how wide to make it: the agents all run either way, and the reason to split work is coverage rather than wall-clock. It does mean a script should not promise the user a fast answer because it fanned out, and should not add a checkpoint or a progress phase that only makes sense if everything starts together.

Enter a phase budget with `phase("Name", { budget: N })`; phase metadata does not carry budgets. `N` is a token allowance, not a call or round count: size it for the intended agent work instead of copying a small iteration limit. Token and phase budgets are soft pre-call gates. Spend lands after agents finish, so concurrent work can overshoot. A phase budget gates later calls in that phase; it neither reserves tokens nor cancels active calls. `budget.spent()` and `budget.remaining()` include nested work.

## Checkpoints

A checkpoint consumes an agent slot but no tokens. A workflow invocation is backgrounded by default, and background workflows are headless: they cannot display checkpoint confirmation. Use `background: false` when a checkpoint must reach the foreground host confirmation interface. Without a UI, a checkpoint returns the declared default (or `true` when omitted) unless `headless: "abort"` is selected. Confirm is implemented. Input, select, and timeout fields are declared for compatibility/future behavior but are not authoring promises.

Checkpoint answers are journaled and can replay during an unchanged resume prefix. Do not describe checkpoints as guaranteed arbitrary forms or as remote steering.

## Retry and recoverable failure

Recoverable execution failures retry according to the per-agent option or invocation-time tool input, then return `null`. Nonrecoverable failures throw without becoming `null`. The logical `retry()` combinator is separate: it performs new agent calls and returns its last result when exhausted unless the script records and handles that outcome.

Always retain `{ id, status, result }` or an equivalent ledger for each intended work unit. Filtering `null` before recording identity turns an execution failure into invisible missing coverage.

`AGENT_EMPTY_OUTPUT` (whitespace-only text from a schema-less call) is recoverable and retries like any other transient failure. Some models occasionally produce it on an otherwise-working first attempt; a fleet built on such a model should set `agentRetries: 1-2` rather than treat one occurrence as a failed run. A `schema` call never trips this check — schema noncompliance is its own, nonrecoverable failure (see [serialization](#serialization)).

## Resume

Resume replays only the longest unchanged prefix of journaled calls. Once one call is new, changed, or unusable, that call and all later calls execute live. Stable lexical call ordering, prompts, labels, routing options, and inputs therefore matter. Retry chains can cascade after an upstream miss. A nested workflow is cached as one parent call; an unchanged child replays its complete result, while a changed or interrupted child runs live in a generation-scoped namespace.

Only a call that finishes with a real result is journaled. A call whose every attempt was recoverable (including one that only ever produced `AGENT_EMPTY_OUTPUT`) contributes no journal entry, so resuming that run reruns exactly that call and everything lexically after it live; the earlier, already-succeeded prefix still replays from cache. Schema repair retries include the concrete validation errors in the next prompt.

The runtime blocks common accidental nondeterminism, but this is not a security boundary. Pass timestamps, randomness, and external decisions through `args`.

## Nesting and shared state

`workflow(savedName, childArgs)` runs sequentially inline, allows one nested level, and shares limiter, counters, token accounting, and shared store with the parent. It is not independent capacity. Use only a saved-workflow name provided by context; do not guess registry entries or pass raw scripts as a new authoring pattern even where compatibility behavior accepts them.

## Serialization

The workflow's explicit return value crosses the tool boundary. Keep it JSON-serializable and preserve coverage ledgers in the returned data. Structured agent schemas must be plain JSON Schema. Schema success guarantees the downstream field shape expected by JavaScript; without a schema, treat output as text or `null`. A prompt that asks the model to "return JSON" does not change this — without `schema`, parse and validate that text defensively before reading a field, and ledger an unparseable result instead of reading `undefined` off it (see [defensive text parsing](focused-recipes.md)).

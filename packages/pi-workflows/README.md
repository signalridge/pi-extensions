# @signalridge/pi-workflows

JavaScript orchestration for Pi. A workflow is a raw JavaScript module executed
in a determinism-guarded `node:vm` realm inside an owned Node helper; the runtime supplies `agent()`,
`parallel()`, `pipeline()`, `orchestrate()`, `workflow()`, quality helpers (`verify`,
`judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`), human
`checkpoint()`, `phase()`, `log()`, `args`, `cwd`, restricted `process`, and
`budget`. Every live `agent()` call is dispatched through the additive
`subagents:rpc:spawn-managed` event-bus protocol — `pi-subagents` remains the
only owner of model, thinking, queue, concurrency, tools, skills, cwd,
isolation, retry, and session policy.

## Install

`@signalridge/pi-workflows` requires `@signalridge/pi-subagents` `>=1.9.0`
with protocol v4 managed-spawn, Agent-tier, and managed-policy support. They are separate Pi packages: the peer
dependency documents the requirement but intentionally does not auto-load or
duplicate the subagent extension.

```bash
pi install npm:@signalridge/pi-subagents
pi install npm:@signalridge/pi-workflows
```

## Use from this checkout

From the repository root, load both local package directories once. Disable
extension discovery so the npm-installed copies do not also load — an npm copy
of one alongside a local checkout of the other loads both, and the duplicate
registers its tools twice:

```bash
pi -ne -e ./packages/pi-subagents -e ./packages/pi-workflows
```

`-ne` skips the installed extension catalogue while keeping explicit `-e`
paths; without it, first remove the installed copies (`pi remove
@signalridge/pi-subagents @signalridge/pi-workflows`) or accept duplicate tool
registration.

Pi activates each package from its own `pi.extensions` manifest.

### JavaScript execution boundary

Only workflow-authored JavaScript and its callbacks run in the helper. Agent
policy/dispatch, scheduling, limits, shared state, journals, and managed-child
cleanup stay in the parent. Callback arguments cross bounded, validated IPC as
opaque callback identities; the parent never executes workflow function objects.
Nested saved workflows get their own helper frame, share the same parent-owned
limits, and remain limited to one nested level. There are no new public globals,
protocol changes, TypeScript helper loaders, or extra runtime dependencies.

A Node host uses its Node executable. Bun or a compiled host requires `node` on
PATH; missing Node fails with an actionable diagnostic. `NODE_OPTIONS` is inherited
unchanged, including debugger flags. A helper that does not announce readiness
within five seconds fails (including `--inspect-brk` awaiting a debugger).

Initial synchronous evaluation retains its one-second VM guard. A local-process
heartbeat detects JavaScript CPU stalls after awaits and in callbacks (including
DAG, gate, retry, and loop callbacks); a stalled heartbeat fails after 1.5 seconds.
This is not a wall-clock deadline for legitimate agent awaits, and never polls a
model. Cancellation/failure closes the actual owned helper through TERM, KILL
escalation after 250ms, and a bounded 1.5-second close wait. Managed children must
still settle exact-owner cleanup before terminal publication or resumability; a
cleanup failure is fenced, not claimed as success. Terminal status, final results,
waiters and background notifications also wait for the exact accepted terminal
transition's journal append to succeed (an append receipt, not an fsync guarantee).
A transient append rejection retains the immutable transition for bounded retries.
Exhaustion never reports success: a receipted persistence failure may settle the run;
otherwise terminal publication remains pending. Stop or branch replacement
invalidates a queued success. A returned value closes new
root-call admission but drains every accepted native operation and nested frame
before success; callbacks needed by those operations remain available. Infinite
awaits in forgotten helpers still require cancellation. Ignored native RPC promises
are observed without changing their awaited/caught values or helper error policy.
Repeated parent event-loop lag earns only one I/O turn per actual heartbeat advance,
never a synthetic heartbeat or an indefinitely renewed stall exemption.

Helpers have a 128MiB V8 heap limit, 4MiB IPC message limit, bounded 32MiB queued
and retained request payloads, 8,192 callbacks/pending requests, 100,000 non-heartbeat
messages, and intermediate value limits of 100,000 nodes/64 levels. Log entries
are bounded to 64KiB characters and 1MiB total bytes per frame. Intermediate arrays,
plain objects, maps, sets, dates, regexes, bigint values, registered callback
references, and error names/classification cross IPC. Input and callback snapshots
use the workflow realm's built-in constructors (including standard error subclasses),
preserve cycles, array holes and undefined, and return registered callbacks to their
original closures. Data transfers do not preserve arbitrary custom prototypes or
cross-transfer object identity.
VM-origin exceptions retain their provenance rather than acquiring native provider
classification from words like "quota"; exception coercion stays in the helper.
Final results must serialize to JSON and return their JSON projection. `phase()`
and `log()` remain synchronous; budget reads mirror parent accounting at RPC replies.
These bounds are guardrails for trusted scripts, **not an OS/security sandbox**.

## Writing a workflow

A workflow script starts with the only legal export — a literal-only meta
contract — and then runs inside an async function:

```js
export const meta = {
  name: "example",
  description: "Fan out three checks and synthesize",
  phases: [{ title: "scan" }, { title: "synthesize" }],
};

phase("scan");
const findings = await parallel([
  () => agent("Check for cross-package imports", { label: "imports", strength: "low" }),
  () => agent("Check for secrets", { label: "secrets", strength: "low" }),
  () => agent("Check for dead code", { label: "dead-code", strength: "low" }),
]);

phase("synthesize");
const report = await agent("Summarize the findings: " + JSON.stringify(findings), {
  label: "report",
});
return report;
```

The meta statement must be the first statement and use only literals — spread,
computed keys, methods, template interpolation, and the reserved keys
`__proto__`/`constructor`/`prototype` are rejected. `Date.now()`,
`Math.random()`, and no-argument `new Date()` are unavailable (an AST precheck
plus in-realm stubs); prompt text containing those words remains valid. Pass
timestamps and randomness through `args`. The vm is
a determinism guardrail, not a security boundary — scripts are generated by the
user's own LLM and run on the user's own machine.

### Runtime globals

- `agent(prompt, { label, phase, schema, strength, isolation, thread, agentType, toolset, excludeTools, timeoutMs, retries })`
  — dispatch one subagent through the managed spawn protocol. Returns text, a
  schema-validated value, or recoverable `null` after retries. Replayed journal
  calls consume no real-dispatch cap or token/phase budget. `schema` is a
  plain JSON Schema; the reply is parsed and validated client-side with bounded
  repair across attempts, and exhaustion throws `SCHEMA_NONCOMPLIANCE`.
  `strength` is the provider-neutral workflow route; `thread` chains sequential turns
  within a named conversation thread. Per-call `model`, `thinking`, and `tier`
  options are rejected; workflow meta/phase model or thinking fields are also
  rejected and are never a workflow policy source. Pre-schema-v4
  journal runs are quarantined and cannot be resumed.
- `parallel(thunks)` — run thunks concurrently, preserve input order. Recoverable
  thunk failures become `null`; non-recoverable failures (token budget, agent
  limit) halt the run after the batch barrier settles. Fan-out that breaches
  `maxAgents` cancels only its own batch; each call accepts at most 4096 thunks.
- `pipeline(items, ...stages)` — items run concurrently, stages per item run
  sequentially with `(previousValue, originalItem, index)`; each call accepts at
  most 4096 items and waits for the batch before surfacing fatal failures.
- `orchestrate(tasks, { onError })` — execute a named dependency graph in
  deterministic declaration-order layers. Each task is `{ id, dependsOn?, phase?,
  retries?, run }`; its callback receives `{ id, attempt, results, statuses }`.
  `onError` is `skip-dependents` (default), `continue`, or `fail-fast`. Results
  are keyed by task id, and task lifecycle events are observable through
  `onRuntimeEvent`.
- `workflow(savedName, childArgs?)` — run a saved workflow inline; one nested
  level, sharing the limiter, counters, token accounting, and store. The child
  result is journaled as one parent call with a generation-scoped namespace, so
  unchanged nested work replays without spawning again after resume.
- `verify(item, { reviewers, threshold, lens })`, `judgePanel(attempts,
  { judges, rubric })`, `loopUntilDry({ round, key, consecutiveEmpty,
  maxRounds })`, `completenessCheck(taskArgs, results)`, `retry(thunk,
  { attempts, until })`, `gate(thunk, validator, { attempts })` — quality
  helpers built purely on `agent()`/`parallel()` so call sequencing stays
  stable and resume keeps working.
- `checkpoint(prompt, { default, headless, kind, choices, timeoutMs })` —
  journaled human confirmation. Foreground runs thread the real UI; background
  runs are headless and take the declared `default`.
- `phase(title, { budget })`, `log(message)`, `args`, `cwd`, `process.cwd()`,
  `budget` (`{ total, spent(), remaining() }`).

Run and phase token budgets are soft pre-dispatch gates: they recheck completed
spend after acquiring runtime capacity and before every provider-agent attempt,
including empty-output retries and schema repairs. Queued calls do not retain an
earlier budget approval. Attempts already running can overshoot; this is not a
hard token or cost cap. Nested live calls share run spend, while phase allowances
remain frame-local and queued calls keep their captured phase allowance. Journal
replay neither re-executes nor charges completed calls.

### Resume

A script edit replays the longest unchanged prefix from the journal and runs
live from the first changed or inserted `agent()`/`checkpoint()` call. The
original invocation `args` and execution limits are frozen and reused on manual
or automatic resume. Pass `resumeFromRunId` with the edited script; unchanged
calls report zero tokens,
and edited calls rotate their managed spawn key generation so pi-subagents
never raises a fingerprint conflict. A failed run accepted through
`resumeFromRunId` first appends/applies a legal interrupted recovery after owned
cleanup and journal settlement; terminal status is never mutated directly to
running. Intentional stops and unconfirmed cleanup remain non-resumable. Local
checkpoints journal attempt identity without inventing a managed child, and a
timed-out call journals its terminal failure after quiescence before returning
recoverable `null`.

## Skills

The package ships three model-routable skills:

- `workflow-authoring` — design, review, and debug custom JavaScript workflows;
  it teaches topology selection, stable work IDs, bounded failure handling, and
  resume-safe authoring.
- `workflow-patterns` — choose and invoke a reviewed built-in for research,
  adversarial review, code review, multi-perspective analysis, or codebase audit.
- `workflow-review` — audit an existing workflow for topology, data flow,
  recovery, resume safety, and publication readiness without editing it.

Use the pattern skill for a standard task, the authoring skill for a custom
workflow, and the review skill before accepting a topology or recovery change.

## Tools and commands

- `workflow`: run a script (`script`) or a saved/built-in workflow (`name`),
  with `args`, `background` (default true), `maxAgents` (default 1000),
  `concurrency` (defaults to the host's pool size), `agentRetries` (default 0),
  `tokenBudget` (default unlimited), `agentTimeoutMs` (default 1800000, `null`
  disables), and `resumeFromRunId`. The execution limits are tuned defaults: a
  caller that names one narrower than the script needs stops the run rather
  than shaping it.

  Concurrency is not configured here at all. A workflow agent occupies one of
  pi-subagents' `maxConcurrent` background slots like any other background
  agent, so that setting is both the width a run defaults to and the ceiling it
  is clamped to — read live from the peer at each start and resume, so one
  setting governs the whole fleet and a run neither guesses it nor exceeds it.
  The peer publishes it only to a caller that requests it by name, so an older
  pair still handshakes; a run that learns no pool size falls back to 16. A
  request above the pool is clamped and the run log says so.

  In practice that pool is usually the *narrower* number, not the wider one: it
  defaults to 4 background slots, so a default pair runs a fan-out four at a
  time. That is the honest width rather than a new restriction — dispatching
  twelve into four slots only ever queued eight — but it does mean a wide
  fan-out finishes in waves, and `maxConcurrent` is the one place to change
  that, for workflows and for every other background agent at once.

  `agentTimeoutMs` counts from the moment the host reports the agent left its
  queue, so waiting for a slot is never charged against the work.
- `workflow_control`: `list`, `get`, `pause`, `resume`, `stop`, or `rm` a run; `rm` writes a durable removal tombstone.
- `pi.events` emits `pi-workflows:runtime` snapshots (`{ runId, event }`) for phase, task, quality, retry, and nested-workflow progress; observer failures are contained.
- `/workflows`: TUI navigator plus `run`, `status`, `watch`, `stop`, `pause`,
  `resume`, `rm`, `save <name> [runId]`, and `strength` subcommands.
- `/workflows strength`: `[<low|medium|high> <tier>|off]` — which Agent tier each
  workflow strength runs on, and the tiers this host defines. Unconfigured hosts
  start on a shipped default table (identity, where the host defines the name).
  The tiers themselves are still configured only in pi-subagents'
  `/agents → Model tiers`; there is deliberately no second tier configuration file.
- `/effort` and `/ultracode`: standing `off|high|ultra` effort guidance that auto-arms substantive messages.
- `/workflows-progress`: `compact|detailed|status|max <N>` controls the persisted live panel.
- `/deep-research`, `/adversarial-review`, `/code-review`,
  `/multi-perspective`, `/codebase-audit`: the five built-in workflows. A
  saved workflow with the same name takes precedence.
- `/workflows-trigger`: `set <keyword>`, `off`, or `on`. See keyword arming below.
- `/<saved-name>`: every saved workflow registers its own slash command at
  `session_start` (Pi cannot unregister commands, so registration happens there
  rather than at factory time, and existing commands are never overwritten).

### Live command center

`/workflows` opens a live, explicitly focused navigator; `/workflows watch <runId>` opens that run directly. Outside TUI, watch reports a snapshot rather than occupying an uncancellable wait. Escape closes observation without stopping execution.

Select a run, then a phase/task/call or its final result. Details have an independently scrollable viewport, while legal controls and help remain pinned. Navigation follows stable identities across updates, removal and resize. Use the displayed selection keybindings, Tab for controls, `p` to pause and `r` to resume. Stop is non-resumable and requires the displayed explicit confirmation; repeating a legacy-terminal key must not confirm it. A pending cleanup is not completion: the inspector keeps uncertainty visible and can recheck owned cleanup.

Phase entry, task attempts and call attribution come from fenced runtime observations. Declared phases never prove completion, and restored journal-only facts do not invent historical labels or entered phases. Exact phase identities distinguish labels whose bounded display copies look the same. Logical calls, replayed calls and physical dispatches are separate counters. Presentation snapshots are detached and bounded; they contain no prompts or conversation histories.

A selected root agent call can open its retained conversation through the subagent owner's optional exact-attempt UI endpoint. Unknown or reused old attempts are not redirected to a newer child. Workflow controls remain here; steering, child stop, sessions, model policy and foreground handoff remain in `pi-subagents`. The optional UI protocol does not change the required managed v4 handshake.

The passive progress panel uses a terminal-height row budget, prioritizes live calls and reports overflow rather than growing as runs × calls. Names/results are sanitized only in display copies; journals and stored source remain unchanged. Fullscreen, regular terminal, RPC and print paths retain their distinct public API boundaries.

### Background result notifications

To explicitly read and acknowledge a terminal result, call
`workflow_control({ action: "get", run_id: "...", consume: true })` (`status`
is an alias). A `notificationConsumed: true` receipt means an acknowledgement
was observed on the active branch and the pending reminder was consumed.
Ordinary `get`/`status`, `list`, running results, and cancelled/stale reads do
not consume future completion. Consumption is scoped to that execution; a
later resumed execution remains eligible. Identity comes from the durable terminal
journal entry, not a runtime counter that restarts on restore. Older markers
without that evidence are not retroactively consumed. Receipts do not delete run history
or retract messages already handed to Pi.

Completed background runs are buffered in branch-local pending-delivery markers
(up to 256, expiring after seven days). Notifications wait for an owned, idle
session with no queued input, input preparation, compaction, or navigation in
progress. A cancellable one-shot timer defers handoff out of the notification-only
`agent_settled` handler and rechecks ownership and readiness; later handlers can navigate
or compact without receiving an old result. Up to eight results are coalesced
per notification, each preview bounded to 8,000 characters. There is no model
polling or repeating delivery timer.

Results first enter context as a `pi-workflows:delivery` custom message with
`triggerTurn: false`. The active branch must actually contain that message before
pending markers are acknowledged. Delivery details record individual run IDs,
so a partial acknowledgement failure cannot resend an already persisted member
of a batch. Every accepted background resume (tool, navigator, or provider timer)
rearms its generation-owned observer; suspension is not final delivery.
Pi's void `sendMessage` return is not an
acceptance promise. A short `sendUserMessage` notification then uses the normal
input and `before_agent_start` path, so prompt preparation hooks still run.
Internal wakes disable command/template expansion and carry private, unique,
one-use admission tokens (at most 256 in memory). Our input hook checks the
original generation, engine, context, and branch ownership before accepting a
wake and removes its token from model-facing text. If an earlier input hook
awaits while navigation or shutdown retires the owner, the obsolete
extension-sourced wake is handled without starting a turn. Interactive/RPC
input and other extensions' messages are not consumed by this guard.

This is a handoff check, not a navigation lock: public hooks cannot fence an
arbitrary later async input or preparation handler that navigates after our
input hook has accepted the wake. Earlier transforms must preserve the private
token until this check; a hook that removes it also removes its ownership evidence.

Unacknowledged markers recover from the active branch on session start or tree
commit; siblings never inherit abandoned-branch results. A blocked or failed
handoff waits for a later lifecycle boundary, not a retry loop. If input or
navigation is abandoned without a completion event, delivery stays conservative
until a fresh prompt (and its eventual settlement) or session/tree rebind.

Shutdown immediately retires both admission and delivery before aborting the
engine, including a peer's bus-first shutdown handshake. Cleanup retains the
outgoing journal until native shutdown finishes; late results cannot wake the
retiring session.

### Keyword arming

Typing the bounded word `workflow` or `workflows` in an ordinary message counts
as an explicit opt-in to multi-agent orchestration. A request-local hidden
`context` overlay tells the model the `workflow` tool is authorized for this turn;
`before_agent_start` admits idle guidance but persists nothing. Keyword and standing
`/effort high|ultra` guidance never append reminders or effort text to native user
messages. Original text/images remain exact, even repeated literal copies of either
directive; only extension-owned custom guidance is filtered/rebuilt. Legacy owned
hidden arming entries are excluded from public branch-summary/compaction preparation,
without rewriting historical user text or stored entries.

Arming **authorizes; it does not compel**. The hidden guidance says the model may run
a workflow and may still decline, so "how do workflows work?" stays an ordinary
question with an ordinary answer. Nothing is swallowed and no UI opens.
This is **model guidance, not an execution permission gate**: the extension does
not enforce the keyword inside `workflow.execute`. Direct tool calls remain
subject to Pi's ordinary tool permissions; do not use the trigger as a security
boundary.

Only a standalone word arms. A workflow is also a thing people write code about,
so none of `myworkflow`, `workflow_name`, `WorkflowEngine`, `--workflow-id`,
`src/workflow-editor.ts`, `workflow.ts`, or the `/workflows` command matches. A
sentence-ending dot is not a filename dot: "please run a workflow." arms, and
`workflow.json` does not. Set a different word with `/workflows-trigger set
<word>` (matched exactly — only the default word also matches its plural) or
turn it off entirely with `/workflows-trigger off`.

Only observed interactive/RPC input can arm a turn; extension-sourced
notifications cannot. Idle admission is one-use and requires unchanged prompt
text, images, session and leaf. Queued follow-up and steering input can also arm:
Pi continues them without a fresh `before_agent_start`, so one bounded queued
admission binds to its public `message_start` and a unique persisted user entry
on the owning branch. The public `context` hook adds a model-only overlay; it
never enters native history. Both paths retire guidance after settlement,
navigation or reload. Standing `/effort high|ultra` permission identifies the
standing setting, not a keyword the user did not type.

Pi's public preparation event has no input source/request ID, and chained input
handlers have no public post-`handled` notification. Overlapping or unmatched
input is therefore denied rather than transferring authorization to another
prompt, even if the text is identical. Multiple unresolved queued observations
are ambiguous and suppress queued guidance until settlement. A consumed idle
prompt may similarly suppress arming on the next ordinary turn. Template
expansion, later text/image transforms, or non-unique native-message evidence
also fail closed. These limits affect advisory guidance only, never direct tool
authorization.

The fix applies to **new messages after updating and reloading the extension**;
source changes do not update an already installed/running package. Previously
persisted user messages containing raw reminders remain unchanged. Pi's public
UI API does not provide a history rewrite: those messages can still appear in
the native TUI, fork selector or editor history. No private renderer patch or
generic reminder stripping is used. Regression tests exercise the real SDK,
faux provider, and native user-message component, not a physical terminal or a
live model service.

Navigator, command-notification and result metadata is sanitized only in display copies through `pi-ui`;
stored results and journals stay original. Detail screens keep actions reachable
in a row-bounded viewport; PgUp/PgDn scroll the detail independently of ↑↓ actions.

Saved workflows use project scope first and a user scope fallback; writes are atomic and names are path-safe.

## Model routing

A workflow speaks one word about cost: **strength**, this package's own name for
how much effort a step deserves. `low`, `medium`, `high` — that is the whole
vocabulary, and a script may name nothing else.

```js
await agent("summarize this diff", { strength: "low" })
await agent("design the migration", { strength: "high" })
await agent("the ordinary case")                          // no strength: see below
```

There is no default strength. A call that names none dispatches with **no tier**,
exactly as an unmapped strength does, and pi-subagents resolves it the way it
resolves any other spawn: the agent type's own frontmatter tier, then
`agentTiers.defaultTier`. That matters because a tier a call requests outranks
the agent type's own — so a default strength would have pinned every unlabelled
call to whatever it mapped to, overruling `Explore`'s shipped `tier: low` and
re-pricing the one agent this indirection exists to leave alone. Label the calls
whose cost you mean to steer; leave the rest to the host.

A strength is not an Agent tier. A `strengths` table is the only thing that
binds one to a tier:

```jsonc
// <agent dir>/workflows/settings.json, or the per-project settings file
{ "strengths": { "low": "cheap-search", "high": "deep" } }
```

**An unmapped strength dispatches with no tier at all** and takes the agent's
ordinary default — the agent's own frontmatter tier, then the host's configured
default. `{}` is a real table meaning exactly that for every strength.

### The default table

A host that has configured nothing does not get "no mappings". It gets a table
this package ships: each strength on the catalogue tier of the same name,
**wherever the host defines one**. On a stock install that is
`low → low, medium → medium, high → high`; on a host whose tiers are called
`cheap` and `deep` it is empty, and every strength is unmapped. It is computed
against the live catalogue rather than hardcoded, so it is never an assertion
about someone else's tier names and never produces a start-up complaint about
configuration you did not write.

Without it, every shipped script's `low`/`medium` distinction would collapse
onto pi-subagents' managed default — which is the *more* expensive rung, so an
unconfigured machine would run its fan-outs dearer, not cheaper.

That it is a **table and not a fallback rule** is the whole design. A rule
saying "an unmapped strength runs on the tier of the same name" would be
unremovable, so making a 26-agent fan-out cheaper would still mean editing tier
`low` itself — dragging the `Explore` agent and everything else that names it. A
table is replaced by writing one, and a written table that omits `low` leaves it
unmapped even on a host that defines a tier called `low`. Nothing is ever
inferred from spelling at dispatch: the binding is always a table entry.

So `low → low` in a written table is a real entry and not a no-op — a table you
write replaces the default outright, so the entries you leave out are unmapped,
not inherited.

### Editing it

`/workflows strength` edits the table and also prints the tiers this host
defines — the one place both halves are visible, since the strengths come from
this package and the tiers from pi-subagents:

```
/workflows strength              # show the effective table and the host's tiers
/workflows strength low cheap    # run workflow strength `low` on Agent tier `cheap`
/workflows strength low off      # unmapped; back to the agent's own default
```

Edits land in **this project's** settings, like every other setting this package
owns. Because the table replaces rather than merges at each level, the command
seeds the write from the table a run would actually use — the project file, else
global, else the shipped default — so setting one entry cannot silently discard
the rest, and `off` clears a mapping this project never wrote. The write is
therefore a full copy of the current table into the project; edit
`<agent dir>/workflows/settings.json` by hand for a machine-wide table.

Any key the host's catalogue defines is a legal target — an existing tier, or a
profile added for exactly this purpose. There is no shortlist and no naming
convention: the target is checked against the live catalogue at run start, so a
profile added to `subagents.json` is usable the moment it exists. One hop, never
chained. An entry whose tier the host does not define is reported once at run
start and ignored, leaving that strength unmapped — a stale entry costs the
redirect, not every workflow on the machine.

This is not the retired `workflow.tiers` key and must not become it. That one
carried its own `model` and `thinking` values, which made it a second model
policy resolved by a second resolver. A value here is a **key in the host's one
catalogue**: pi-subagents still owns every model, every thinking level, and the
only `resolveAgentTier()`, and cannot tell a mapped call apart from a spawn that
named the key itself.

There is no per-call `model`, `thinking`, or `tier`, and `meta`/phase metadata
may not carry them either. A strength is the only model policy a workflow can
express, which is what keeps a script from pinning a vendor the host did not
choose.

The vocabulary is closed so that a word outside it is a *typo* rather than a
strength nobody configured: `agent({ strength: "lowe" })` fails before any
dispatch instead of silently running at the default.

The same argument applies one level up, to the option *name*. `agent()` and
`checkpoint()` reject any key they do not read, rather than ignoring it:

```js
await agent("x", { tier: "low" })      // → name a strength instead: one of low, medium, high
await agent("x", { model: "…" })       // → a strength is the only model policy a workflow can express
await agent("x", { strenght: "low" })  // → valid options are: label, phase, schema, strength, …
```

An unknown key is dropped before the call hash is built, so it changes neither
the dispatch nor the resume identity — the run would simply spend at a policy
nobody chose, and a resume would replay it without noticing. A script is plain
JavaScript authored against this contract, so there is no other gate: a
misspelled option would run every step untiered, and a misspelled
`checkpoint({ headles: "abort" })` would auto-approve in headless mode instead
of aborting.

### Helpers that dispatch for you

`verify()`, `judgePanel()`, and `completenessCheck()` spawn agents on the
script's behalf, so the script cannot label those calls. Each carries a
documented default and takes an override, which keeps every dispatch inside the
vocabulary:

```js
await verify(finding)                              // reviewers run at "low"
await verify(finding, { strength: "high" })        // unless you say otherwise
await completenessCheck(args, results)             // one open-ended read: "medium"
```

These defaults are an opinion, and an opinion outranks the host's: a tier a call
requests beats `agentTiers.defaultTier`, so on a machine whose default is `high`
a `completenessCheck` now runs at whatever `medium` maps to rather than at
`high`. That is the trade for making the helpers re-routable at all — they
previously named no tier and could never be steered — and the override above is
how a script takes it back.

### Resume

The table is read fresh at each start and resume — including the resumes the
engine starts itself, `/workflows resume` and the provider-limit retry — never
frozen onto a run.

Resume identity keys a call on the tier it will actually request, so editing the
table and resuming re-routes the calls that have not run — and **also re-runs
the finished calls whose strength moved**, plus everything after the first such
miss, because their cached answers came from a different tier. Re-routing
mid-run is therefore a re-spend; if the point of the edit was to spend less,
start a new run instead of resuming one that is mostly done. The provider-limit
retry resumes on a timer with no one watching, so a table edited while a run is
rate-limit-paused is charged the same way without being asked — stop that run
before editing if the re-spend is not worth it. A nested
`workflow()` boundary folds the table into its own key for the same reason: the
value it caches for the whole child frame would otherwise survive a change that
re-routes the child.

Fresh installs of pi-subagents ship `low`/`medium`/`high` tier profiles, all
inheriting their model — which is what the default table above resolves against,
so the built-ins run on a new machine, at their own strengths, with no
configuration. A managed call that still names no tier falls back to `medium`;
that is where an unmapped strength lands. The fallback is scoped to managed
calls: it is not the catalogue's `defaultTier`, so an ordinary `Agent` spawn on
the same machine keeps falling through to `defaultModel` and the parent session.
A host whose default has been cleared (`noDefaultTier`) rejects an untiered
managed call rather than quietly inheriting the parent session's model — which
an unmapped strength can reach.

The managed wire, invocation record, journal, tombstone, and resume state all
carry the one resolved tier — including one the host defaulted to, so a run's
record says what actually ran. Resume keys each cached call on the policy for
*that call's* tier: editing an unrelated tier does not invalidate work that never
used it.

## Intentional adaptations from upstream

- **No host-side web tools.** Agents reach the web through configured pi-web-access/MCP tools or an agent type's tool policy.
- **Agent registry and tier catalogue ownership.** `agentType` and the tier catalogue resolve in pi-subagents; the workflow package supplies only a tier key its own `strengths` table chose, avoiding a second model/thinking policy.
- **Schema validation is client-side.** The managed request does not assume a structured-output tool; the runtime asks for JSON, parses, validates (including `additionalProperties`), and repairs across bounded attempts.

State is persisted as `pi.appendEntry("pi-workflows:journal", ...)` custom entries (schema v4), including frozen invocation args, resolved tier identity, terminal result previews, script revisions, named nested-workflow result boundaries, and durable removals. Interrupted/provider-limited runs replay from the journal; pre-schema-v4 journals are quarantined rather than replayed. Foreground `AbortSignal`s stop owned children through explicit owner-scoped stop/quiescence, and dispose/branch replacement reject stale waiters. Navigation preflight vetoes while agents or workflows are active or cleaning up, without interrupting them. An accepted tree commit fences old callbacks in either extension load order and restores only the committed branch; preflight itself is not a commit point.

## Status navigation

With a compatible status selector, **Ctrl+Alt+S**, choose **Workflow runs**, then
**Enter** opens this package's existing workflow navigator. `/workflows` and its
watch/detail paths remain unchanged. Querying this optional TUI-only endpoint
never opens a screen, starts/resumes a run, or sends a model/user message. Each
selection belongs to one live session/branch surface; navigation and reload
retire it rather than redirecting an old selection to another owner. Only
bounded identifiers and labels cross this presentation wire, not execution
controls, source, logs, or callbacks.

The compact `pi-workflows` footer reports `A` active runs (pending, running,
pausing, stopping) and `P` paused/interrupted runs. With only retained terminal
runs it reports `C` completed, `F` failed, and `S` stopped counts; an empty run
list clears it. Counts reflect run status, never inferred child completion.
This uses the existing progress refresh cadence without adding another widget
or taking focus.

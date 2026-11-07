# pi-workflows reference

[Start with the README](../README.md).

- [JavaScript execution boundary](#javascript-execution-boundary)
- [Runtime globals](#runtime-globals)
- [Resume](#resume)
- [Model routing](#model-routing)
- [Live command center](#live-command-center)
- [Background result notifications](#background-result-notifications)
- [Keyword arming](#keyword-arming)
- [Persistence and navigation](#persistence-and-navigation)
- [Status navigation](#status-navigation)

## JavaScript execution boundary

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

## Runtime globals

The shipped [capability index](../skills/workflow-authoring/references/capabilities.md) is canonical for all signatures, options and defaults; its [exhaustive facts](../skills/workflow-authoring/references/capability-details.md) define helper bounds and validation. In particular:

- [agent](../skills/workflow-authoring/references/capability-details.md#runtime-global-agent) dispatches through managed spawning. It returns text, a schema-validated value or recoverable null after retries. Bounded client-side JSON Schema repair exhaustion throws `SCHEMA_NONCOMPLIANCE`. `strength` is the only model policy; thread turns are sequential. Pre-schema-v4 journals are quarantined.
- [parallel](../skills/workflow-authoring/references/capability-details.md#runtime-global-parallel) and [pipeline](../skills/workflow-authoring/references/capability-details.md#runtime-global-pipeline) preserve input order and settle the batch before fatal errors. Each accepts at most 4096 entries; an agent-cap breach cancels only its own batch. Pipeline stages receive previousValue, originalItem and zero-based index.
- [orchestrate](../skills/workflow-authoring/references/capability-details.md#runtime-global-orchestrate) uses declaration-order DAG layers. Tasks are `{ id, dependsOn?, phase?, retries?, run }`; callbacks receive `{ id, attempt, results, statuses }`, results use task IDs, and `onRuntimeEvent` observes lifecycle. The linked contract owns onError modes/defaults.
- [workflow](../skills/workflow-authoring/references/capability-details.md#runtime-global-workflow) allows one nested level sharing limiter/counters/accounting/store; generation-scoped child results replay as one parent call.
- Quality helpers are built on agent/parallel, preserving resume-stable sequencing. [checkpoint](../skills/workflow-authoring/references/capability-details.md#runtime-global-checkpoint) journals real foreground UI answers or background headless defaults. Phase/log remain synchronous; args/cwd, restricted process and budget are data views.

Timeout scope matters when reading generated facts: `agentTimeoutMs: null` is an engine API option, **not** a validated public workflow-tool input; that tool schema accepts numbers.

Run and phase token budgets are soft pre-dispatch gates: they recheck completed
spend after acquiring runtime capacity and before every provider-agent attempt,
including empty-output retries and schema repairs. Queued calls do not retain an
earlier budget approval. Attempts already running can overshoot; this is not a
hard token or cost cap. Nested live calls share run spend, while phase allowances
remain frame-local and queued calls keep their captured phase allowance. Journal
replay neither re-executes nor charges completed calls.

## Resume

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

Absent configuration maps each strength to the same-named live Agent tier, only where defined (stock: low/medium/high). A host with only cheap/deep gets an empty table. An explicit table replaces the default, not a fallback rule: omitted strengths remain unmapped even if that tier name exists. `{}` unmaps all. Explicit identity entries such as `low → low` are real entries. This lets workflow fan-outs be repriced without editing Explore's shared `low` tier.

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

The retired `workflow.tiers` carried model/thinking values. `strengths` carries only keys in pi-subagents' one catalogue; it introduces no second resolver. Per-call `model`, `thinking` and `tier`, and meta/phase model policy, are rejected.

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

Rejecting unknown keys prevents silent policy loss and unchanged resume hashes: if ignored, a misspelled strength would spend untiered, while `checkpoint({ headles: "abort" })` could auto-approve instead of aborting in headless mode.

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

## Live command center

`/workflows` opens a live, explicitly focused navigator; `/workflows watch <runId>` opens that run directly. Outside TUI, watch reports a snapshot rather than occupying an uncancellable wait. Escape closes observation without stopping execution.

Select a run, then a phase/task/call or its final result. Details have an independently scrollable viewport, while legal controls and help remain pinned. Navigation follows stable identities across updates, removal and resize. Use the displayed selection keybindings, Tab for controls, `p` to pause and `r` to resume. Stop is non-resumable and requires the displayed explicit confirmation; repeating a legacy-terminal key must not confirm it. A pending cleanup is not completion: the inspector keeps uncertainty visible and can recheck owned cleanup.

Phase entry, task attempts and call attribution come from fenced runtime observations. Declared phases never prove completion, and restored journal-only facts do not invent historical labels or entered phases. Exact phase identities distinguish labels whose bounded display copies look the same. Logical calls, replayed calls and physical dispatches are separate counters. Presentation snapshots are detached and bounded; they contain no prompts or conversation histories.

A selected root agent call can open its retained conversation through the subagent owner's optional exact-attempt UI endpoint. Unknown or reused old attempts are not redirected to a newer child. Workflow controls remain here; steering, child stop, sessions, model policy and foreground handoff remain in `pi-subagents`. The optional UI protocol does not change the required managed v4 handshake.

Workflows owns one rich passive overview **below the editor**; there is no second upper workflow list. Rows put the workflow name first, followed by semantic status, the observed current phase, running/total call counts, done/failed counts, elapsed time and available **settled-call tokens**. Tokens are completed call-result totals, not live in-flight usage; unknown is omitted and an explicit zero stays zero. Paused, stopping and childless runs remain visible; recent terminal runs linger for four seconds, while all retained history stays in `/workflows`.

`/workflows-progress compact|detailed|status|max <N>` retains its settings: `status` reports them, `detailed` adds bounded call rows, and `max` caps shown runs/calls. The panel uses a terminal-height row budget, prioritizes live calls and reports overflow rather than growing as runs × calls. Names/results are sanitized only in display copies; journals and stored source remain unchanged. The panel takes no empty-prompt arrow keys: `/workflows` is the authoritative navigator. Closing or disposing presentation never stops execution. Fullscreen, regular terminal, RPC and print paths retain their distinct public API boundaries.

Subagents Fleet lists independent agents only. For retained children, use a selected root call in `/workflows`, or `/agents → Retained workflow children` to open the owner inspector or directly inspect the bounded child list. The latter also works when the workflow UI peer is absent or Fleet is disabled. `/agents → Agent runs` retains individual sessions and child steering/stop controls; eligible independent foreground agents keep handoff. Workflow controls and model/execution policy do not move across owners. The optional validated UI query/change/open bridge remains available to external observers and is not a usage RPC.

**Mixed-version UI caveat:** update both packages together for this ownership layout. An older Subagents may still render its own workflow overview alongside the new panel. A newer Subagents with older Workflows hides owned Fleet rows but leaves the older upper progress list in place. Managed protocol v4 and exact-attempt conversation admission are unchanged; no untyped event guessing or automatic legacy-peer suppression is used.

## Background result notifications

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

No wake is sent while the session's latest meaningful response overflowed the model's
context window and no compaction followed it: that turn would resend the same
over-window context and fail again. Results are still delivered and acknowledged
as context, and one warning per overflow episode asks to run `/compact` (or
`/codex-compact` when installed) or start a new session. A compaction or a later
successful response restores normal wakes. Aborted responses and transient errors
(including HTTP 503 and rate limits) do not prove context recovery.

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

## Keyword arming

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

## Persistence and navigation

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

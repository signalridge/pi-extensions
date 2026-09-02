---
name: workflow-authoring
description: Design, write, review, and debug Pi JavaScript workflows that coordinate multiple subagents. Use when a request needs named dependencies, bounded fan-out, per-item pipelines, quality gates, saved or nested workflows, pause/resume, or workflow progress; do not use it merely to run an existing named workflow.
metadata:
  version: "1.7.0"
---

# Workflow authoring

A workflow is a small program that coordinates subagents; it is not a long prompt
that asks one agent to do every step. Keep semantic work in agents and keep
identity, ordering, bounds, failure handling, and aggregation deterministic in
JavaScript.

## Operating contract

- Use a workflow only when the task benefits from multiple agents, explicit
  stages, independent coverage, or a quality/recovery loop. One or two simple
  delegations should use the ordinary agent surface.
- Start every script with literal `export const meta = { name, description,
  phases? }`. Return plain JSON data explicitly.
- Use `orchestrate()` for named dependencies, `parallel()` for a small
  independent barrier, and `pipeline()` for independent items that each need a
  sequential stage chain. Do not encode a dependency graph only in comments.
- Give every work unit a stable ID and every agent call a short unique label.
  Keep IDs beside results before filtering; `null` is missing coverage, not a
  successful finding.
- Bound the algorithm inside the script: graph tasks, fan-out items, loop
  rounds, semantic retries, and evidence size. The invocation-level limits
  (`maxAgents`, `concurrency`, `agentRetries`, `tokenBudget`, `agentTimeoutMs`)
  are tuned defaults rather than the place to express a bound; each one stops or
  fails a run that outgrows it, so a precautionary value cuts the coverage and
  not the cost. Set one only when the user asked for that limit.
- Size the fan-out to the evidence the task actually has: one agent per
  independent question, ten to thirty for an ordinary review or audit. The gain
  is coverage — one agent asked one question reads further into it than one
  agent asked four. Speed is a separate matter and not yours to decide: how many
  of those agents run at once is the host's `maxConcurrent` pool, so a wide
  fan-out on a narrow pool still finishes in waves. Split for what gets looked
  at, not for wall-clock.
- Route an agent call with `strength: "low" | "medium" | "high"` — this
  package's own word for how much effort a step deserves, and the only routing
  word a workflow has. It is **not** an agent-tier key: a `strengths` table
  alone binds a strength to a tier — the user's, or the shipped default on a
  host that configured none — and a strength no table defines dispatches with no
  tier and takes the agent's own default. So name the effort the step deserves
  and never reach for a catalogue name; a word outside the three is rejected
  before dispatch, as is `tier:` itself. There is no default: omitting
  `strength` dispatches with no tier and lets the agent type's own tier stand,
  so label the calls whose cost you mean to steer and leave the rest alone.
  There is no per-call `model`/`thinking`/`tier`, and none may
  appear in workflow meta or phase profiles. `agent()` and `checkpoint()` reject
  any option name they do not read rather than ignoring it, so pass only the
  documented keys. Never guess an agent-type name—use
  names supplied by the current environment and follow
  [registry ownership](references/registry-ownership.md).
- Pick that word by what a wrong answer costs, not by how important the step
  feels. `low` is retrieval, navigation, and read-heavy breadth. `medium` is the
  ordinary working rung and where a labelled step belongs unless you can say why
  not. `high` is for a step whose error is expensive to reverse — an architecture
  decision, a destructive migration, a security boundary — and a fan-out normally
  names it zero times, at most once on a closing step that actually decides
  something. It is not a reward for the hardest-sounding task: routing a whole
  fan-out to `high` prices every branch at the cost of the one that mattered, and
  buys depth where the run needed coverage.
- Workflows have no imports, filesystem/network APIs, timers, or unrestricted
  Node APIs. Pass timestamps, randomness, and external decisions through `args`.

## The authoring pass

1. **Classify the topology.** Decide whether the work is direct, a named DAG,
   homogeneous fan-out, a per-item pipeline, iterative discovery, or a quality
   gate. Read [pattern selection](references/pattern-selection.md) only for the
   chosen shape.
2. **Declare inputs and bounds.** Read `args` once, normalize the input, reject
   or cap untrusted cardinality, and decide what incomplete coverage means.
3. **Write the envelope.** Declare only phases that are actually entered. Use
   `phase(title, { budget })` for a soft token sub-budget, not as a scheduler.
4. **Build the smallest work ledger.** Store `{ id, status, result, error }`
   (or an equivalent object) for each intended unit. Do not lose identity when
   applying `.filter(Boolean)`.
5. **Dispatch with the right primitive.** Await every batch. For a dependent
   prompt, include both the dependency ID and its actual result; do not assume
   the child can see the parent conversation.
6. **Add quality only where it changes a decision.** Use a schema before reading
   structured fields, then use `verify`, `judgePanel`, `gate`, or
   `completenessCheck` with explicit bounds. These dispatch on your behalf, so
   pass `strength` when the default (`low`, or `medium` for
   `completenessCheck`) is not the effort that gate deserves.
7. **Aggregate and report.** Return a bounded JSON result containing the answer,
   coverage, and important failures. If the workflow runs in the background,
   the run ID is the handle for later control/resume.
8. **Review the script.** Use [the review checklist](references/review.md), then
   test with deterministic fake agents when changing topology or recovery.

## Topology rules

### Named dependencies: `orchestrate`

Use a task graph when a later step consumes a named earlier step:

```js
const graph = await orchestrate([
  { id: "scan", run: () => agent("Inspect the target", { label: "scan" }) },
  { id: "security", run: () => agent("Check security risks", { label: "security" }) },
  {
    id: "report",
    dependsOn: ["scan", "security"],
    run: ({ results, statuses }) =>
      agent(
        "Synthesize the named findings; mention unavailable coverage.\n\n" +
          JSON.stringify({ results, statuses }),
        { label: "report" },
      ),
  },
]);
return graph;
```

`orchestrate()` validates IDs, missing dependencies, duplicate edges, and
cycles before callbacks run. It executes ready tasks in declaration-order
layers with a barrier between layers and returns `{ results, tasks }`. Each task
callback receives detached `{ id, attempt, results, statuses }` snapshots.
`retries` retries ordinary task-callback failures up to three times. The default
`onError: "skip-dependents"` prevents a failed dependency from feeding a stale
prompt; use `onError: "continue"` only when the dependent explicitly handles
failed statuses. `fail-fast` stops discovery of later layers after the current
layer settles.

### Independent fan-out: `parallel`

Pass thunks, not already-started promises. Results preserve input order and a
recoverable item failure becomes `null`; fatal errors surface after the whole
batch barrier settles. Keep a ledger with IDs before filtering:

```js
const work = items.map((item) => ({ id: item.id, item }));
const outputs = await parallel(work.map(({ item }) => () =>
  agent("Handle item " + item.id, { label: "item-" + item.id }),
));
const ledger = work.map(({ id }, index) => ({ id, result: outputs[index] }));
```

Each `parallel()` call accepts at most 4096 thunks. It is a barrier: do not
start synthesis until the returned array is complete.

### Per-item stages: `pipeline`

Use `pipeline(items, ...stages)` when every item follows the same chain. Items
run concurrently, but stages for one item are sequential and receive
`(previousValue, originalItem, index)`. A stage failure drops that item to
`null`; guard missing values before the next stage. There is no cross-item
barrier between stages, and each call accepts at most 4096 items.

### Saved or nested workflows

`workflow(name, childArgs)` resolves a context-supplied saved workflow and runs
it inline with the parent's limiter, agent accounting, token accounting, and
store. One nested level is allowed; concurrent siblings are allowed. An
unchanged child is replayed as one parent journal call, while a changed or
interrupted child receives a generation-scoped managed identity. Do not use
nesting as an unbounded recursion mechanism.

## Prompt and result discipline

Every child prompt must be self-contained: state the role, exact task, relevant
inputs, expected output shape, and what the child must not do. Prefer a small
`schema` for values JavaScript will inspect. When a child consumes another
child's output, include the stable ID and actual bounded data, for example:

```js
const prompt = "Review result " + JSON.stringify({ id: "scan", result: scan });
```

Do not pass whole transcripts when a summary or structured fields are enough.
Use `log()` for progress and return a result that distinguishes completed work,
missing coverage, and failed/skipped work.

## Failure, limits, and recovery

- Recoverable child failures return `null` after agent retries. Fatal workflow
  errors (invalid hooks, exhausted hard limits, unsupported selectors, and
  schema exhaustion) throw and must not be dissolved into a normal result.
- Runtime `agent({ retries })` retries execution failures. `orchestrate` task
  `retries` retries the callback. Semantic `retry()`/`gate()` attempts are a
  third, intentional layer. Bound and ledger every layer separately.
- `agent()` schema repair includes concrete validation feedback in the next
  attempt. Do not read fields from an unvalidated text response.
- `checkpoint()` is headless by default for background runs. Use
  `background: false` only when a human decision must be shown.
- `budget` and phase budgets are soft pre-call gates; concurrent work may
  overshoot. Do not promise an exact token ceiling unless the caller supplied
  and accepted that policy.

## Resume and publication gate

Resume replays the longest unchanged prefix of journaled calls. Keep call order,
labels, prompts, routing options, and inputs stable. `orchestrate` layer order
and named dependency results make dynamic plans easier to replay, but arbitrary
branch/loop call counts can still invalidate the positional prefix. Never use
`Date.now()`, `Math.random()`, or no-argument `new Date()` in a script.

Before shipping a workflow change:

- read [lifecycle](references/lifecycle.md) for pause, stop, budget, and resume;
- read [debugging](references/debugging.md) when reproducing a failure;
- read [the review checklist](references/review.md) before accepting topology;
- read [the generated capability index](references/capabilities.md) when a
  signature, default, or support boundary is disputed; remember that a strength
  is this package's own vocabulary, bound to a host tier only by the user's
  `strengths` table, while model/thinking resolution stays in pi-subagents;
- ensure every package-relative example/reference link remains inside the
  publishable package.

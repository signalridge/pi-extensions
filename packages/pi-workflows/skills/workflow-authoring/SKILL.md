---
name: workflow-authoring
description: Design, write, review, and debug Pi JavaScript workflows that coordinate multiple subagents. Use when a request needs named dependencies, bounded fan-out, per-item pipelines, quality gates, saved or nested workflows, pause/resume, or workflow progress; do not use it merely to run an existing named workflow.
metadata:
  version: "1.4.0"
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
- Bound graph tasks, fan-out items, loops, retries, agents, concurrency, and
  evidence size. Invocation-level token and time caps are user constraints, not
  substitutes for algorithmic bounds.
- Route an agent call with `tier: "<key>"`, naming a tier the destination host
  defines. Omitting `tier` uses the agent's own tier, then the host's configured
  default; a host whose default has been cleared rejects the call rather than
  inheriting the parent model. There is no per-call `model`/`thinking`, and
  neither may appear in workflow meta or phase profiles. Never guess a tier or
  agent-type name—use names supplied by the current environment and follow
  [registry ownership](references/registry-ownership.md).
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
   `completenessCheck` with explicit bounds.
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
  signature, default, or support boundary is disputed; remember that a tier
  names a key in the host catalogue while model/thinking resolution stays in
  pi-subagents;
- ensure every package-relative example/reference link remains inside the
  publishable package.

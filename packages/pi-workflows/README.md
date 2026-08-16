# @signalridge/pi-workflows

Declarative DAG orchestration for Pi. The `workflow` tool validates phases, task dependencies, cycles, bounded synthesis input, and optional `small`/`medium`/`large` semantic tiers, then submits ready tasks through the additive `subagents:rpc:spawn-managed` event-bus protocol. `pi-subagents` remains the only owner of model, thinking, queue, concurrency, tools, skills, cwd, isolation, retry, and session policy.

## Install

`@signalridge/pi-workflows` requires `@signalridge/pi-subagents` `>=1.0.0` with protocol v3 managed-spawn support. They are separate Pi packages: the peer dependency documents the requirement but intentionally does not auto-load or duplicate the subagent extension.

```bash
pi install npm:@signalridge/pi-subagents
pi install npm:@signalridge/pi-workflows
```

## Use from this checkout

From the repository root, load both local package directories once:

```bash
pi -e ./packages/pi-subagents
pi -e ./packages/pi-workflows
```

Pi activates each package from its own `pi.extensions` manifest. Install `pi-workflows` and `pi-subagents` from the same source — an npm copy of one alongside a local checkout of the other loads both, and the duplicate registers its tools twice.

At `session_start`, this extension sends `subagents:rpc:ping` and verifies protocol version 3 plus the `managedSpawn`, `lifecycleOwner`, owner-scoped `ownedStop`, `ownedQuiescence`, and `workflowTiers` capabilities. The package floor and capability check prevent older v3 peers from receiving tiered requests they cannot validate. If the fork is missing, old, or duplicated incorrectly, workflow execution returns a diagnostic naming the required packages instead of dispatching agents. The legacy unowned stop RPC remains available to older external callers, but workflow cleanup never falls back to it.

## Tools and command

- `workflow`: run a foreground or background workflow. `depends_on` is a scheduling barrier only. A task may additionally declare `inputs`, a duplicate-free subset of its own `depends_on`, to have those dependencies' journaled results appended to its dispatch prompt: each result is capped at 6,000 characters, the appended section at 24,000, and the whole prompt at the protocol's 100,000-character ceiling. When the task prompt leaves less than 512 characters of headroom, nothing is appended and the prompt dispatches unchanged. Omitting `inputs` dispatches exactly the authored prompt.
- `workflow_control`: `list`, `get`, `pause`, `resume`, or `stop` a run. `get` returns bounded task and synthesis details including status, agent ID, compactions, and result/error previews.
- `/workflows`: TUI run list/detail navigator. Live agent conversation navigation remains in pi-subagents FleetView.

Composed input sections are a pure function of the journaled prefix — declared `inputs` order, journaled result fields only — so a replay reproduces the same prompt and the managed spawn fingerprint stays stable across a branch rewind.

State is persisted as `pi.appendEntry("pi-workflows:journal", ...)` custom entries, which do not enter model context. Results and synthesis instructions are capped before journaling or dispatch. Interrupted runs reset unreconciled dispatches to a recoverable state and reuse their managed spawn keys; completed task facts are not dispatched again. A task failure stops remaining owned agents, journals their terminal callbacks, blocks dependents, and settles the workflow as failed.
Restore rotation is journaled atomically per run (`run_recovery`) so a failed append leaves no partial generation; older multi-entry recovery prefixes remain replayable and are migrated with independent `attempt_recovery` entries.
Each atomic recovery also carries a deterministic bounded `recoveryId` derived from its branch/run and attempt rotations. Replay treats an exact normalized duplicate as a no-op, quarantines same-ID conflicts, and accepts older schema-v2 atomic entries without an ID only through deterministic legacy normalization.
Managed lifecycle calls are owner-scoped to the exact `{ runId, nodeId, attemptId }` generation. Branch replacement stops/quiesces owned agents and tracks in-flight dispatch RPCs; if a peer cannot settle, the run is quarantined conservatively and late lifecycle or spawn replies are ignored. Foreground `AbortSignal`s cancel only the caller's wait. The session signal may cancel an outstanding RPC wait during shutdown, but neither signal is used to cancel a managed child; explicit stop/quiescence owns child cancellation.


Interrupted-attempt recovery is intentionally bounded to three generations per task, including synthesis. Normal interruptions retry with a fresh managed attempt; if the same node is interrupted repeatedly beyond that bound, the workflow fails safely instead of creating an unbounded outer retry loop.

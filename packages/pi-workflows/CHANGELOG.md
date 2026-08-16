# Changelog

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

### Minor Changes

- Chain dependency results into downstream prompts, sanitize child-agent output in the navigator, and make the detail-menu action mapping exhaustive.
  
  - `inputs`: a task may declare `inputs`, a duplicate-free subset of its own `depends_on`, so those dependencies' journaled results are appended to its dispatch prompt. `depends_on` on its own stays a pure scheduling barrier, so the DAG can now chain and not only fan out. The field is opt-in: a task without `inputs` dispatches a byte-identical prompt to before. Composition is a pure function of the journaled prefix — the declared `inputs` array is iterated in order and only journaled result fields are read — so a replay recomposes the same prompt and pi-subagents' managed spawn fingerprint stays stable across a branch rewind. Each result is capped at 6,000 characters and the appended section at 24,000, budgeted against the managed protocol's 100,000-character prompt ceiling, which rejects rather than truncates; when the authored prompt leaves too little headroom, nothing is appended.
  - Forward-only journal compatibility: a `run_created` definition carrying `inputs` fails validation on an older `pi-workflows` build, which quarantines and reports that run rather than replaying it. Downgrading after authoring a workflow with `inputs` is not supported.
  - Terminal safety: task results, task errors, and run errors are child-agent output and reached the `/workflows` navigator unsanitized, so a child could emit escape sequences that clear the screen, plant an OSC 8 hyperlink, or reorder the line with a bidi override. Every untrusted string is now neutralized before it is truncated — truncating first could cut through a sequence and leave a live introducer behind.
  - `result_truncated=` in synthesis context now reflects the journaled `truncated` flag, which was previously always reported as `false` because results are already capped when they are journaled.
  - Regression-proofing, not a behavior change: the `/workflows` detail menu built its action list from inline status literals. That mapping is now an exhaustively-typed `workflowActionsFor`, so adding a workflow status is a compile error instead of a silently wrong menu. Every status offers the same actions it did before.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @signalridge/pi-subagents@1.0.0
  - @signalridge/pi-subagents-protocol@1.0.0

## Unreleased
- **Semantic workflow tiers:** tasks, synthesis, and an optional run default can request only `small`, `medium`, or `large`; model and thinking policy stays inside pi-subagents. The release requires `@signalridge/pi-subagents >=0.16.0-signalridge.1` and the v3 `workflowTiers` capability.

- Persist restore recovery as one validated run-level atomic event, with bounded task/synthesis rotations, terminal-record reconciliation, and legacy-prefix migration.
- Add deterministic bounded recovery IDs and per-run duplicate replay quarantine; legacy schema-v2 atomic records without an ID are normalized once without weakening generation checks, and durable-append retries remain exactly-once.
- Require the protocol's owner-scoped quiescence capability and keep terminal cleanup in `stopping` until managed sessions and dispatches have actually settled; retry transient recovery and lifecycle journal appends.
- Quiesce managed agents that answer a spawn request after stop or branch replacement, preventing a late dispatch from being published as a false terminal workflow.
- Preserve exact terminal cleanup targets across retries and fail closed when legacy peers cannot prove dispatch quiescence.
- Keep observed terminal lifecycle facts ahead of synthetic stop/failure facts while journal retries or durable prefixes remain unresolved; a permanently blocked journal stays nonterminal.
- Owner-quiesce late spawn responses during branch replacement and report any late target that cannot settle instead of treating dispatch completion as proof.

- Require and verify pi-subagents protocol v3 before managed workflow dispatch, including the owner-scoped `ownedStop` capability; workflow cleanup fails closed instead of falling back to unowned stop.
- Recover unreconciled dispatches, settle stop/failure cleanup, and expose bounded run details.
- Bound synthesis instructions and aggregate input to 48,000 characters.
- Replay current-attempt interrupted records as one journaled attempt generation without creating failed task facts; stale records are ignored after replay.
- Fail stopped-task workflows conservatively and report/quarantine incomplete branch quiescence instead of accepting late lifecycle events.
- Keep protocol discovery nonblocking and defer the missing-companion diagnostic until a workflow tool call.
- Bound interrupted-attempt recovery to three generations per node, including synthesis, and fail safely beyond the limit instead of retrying an outer workflow indefinitely.
- Supersede every unreconciled task and synthesis dispatch during restore, including dispatches without agent IDs, before resuming lifecycle listeners.
- Require attempt-scoped owners for managed stop/quiescence, track dispatches without agent IDs during branch changes, and quarantine stale responses before they can mutate the restored run.
- Keep foreground wait cancellation separate from managed child cancellation; session shutdown only aborts the caller's outstanding RPC wait.

---
name: workflow-review
description: Audit an existing Pi JavaScript workflow for topology, prompt/data flow, limits, failure handling, cancellation, resume safety, and publication compatibility. Use when reviewing or debugging a workflow script or saved run; do not use to run a standard named workflow.
metadata:
  version: "1.5.0"
---

# Workflow review

Review the workflow as an executable orchestration program, not as prose. The
review is read-only unless the user explicitly asks for a fix. Report concrete
failure scenarios and evidence; do not recommend extra agents merely because
they are available.

## Review procedure

1. **Identify the boundary.** Read the complete script, its invocation `args`,
   saved-workflow source if applicable, and the relevant package version. Do not
   infer behavior from a truncated run notification.
2. **Map the topology.** List every work unit and its stable ID. Mark each as a
   direct call, `orchestrate` task, `parallel` item, `pipeline` stage, loop
   round, quality helper, checkpoint, or nested workflow. Draw the dependency
   edges and barriers in declaration order.
3. **Trace data flow.** For every downstream prompt, identify the exact input
   values and their bounds. Confirm that structured fields have a schema and
   that failed/null results remain visible in a ledger.
4. **Check admission.** Verify finite bounds for task count, fan-out, loops,
   retries, concurrency, token budget, timeout, and evidence size. Check that
   a graph validates IDs, references, duplicate edges, and cycles before any
   callback runs.
5. **Check failure policy.** Distinguish recoverable child `null` from fatal
   workflow errors. For graphs, verify whether the default
   `skip-dependents`, explicit `continue`, or `fail-fast` policy matches the
   task. Ensure ordinary task retries do not silently duplicate side effects.
6. **Check lifecycle.** Verify every batch is awaited, cancellation stops
   owned work, checkpoints have a headless behavior, and nested workflows stay
   within one level and shared capacity.
7. **Check resume.** Keep call order, labels, prompts, routing options, and
   inputs stable. Confirm that edited or missing calls invalidate downstream
   replay and that nested results use a generation-scoped boundary. Treat
   effectful worktree/file changes as non-replayable unless its effects are
   explicitly restored.
8. **Check publication.** Confirm the literal meta envelope, no imports or
   nondeterministic APIs, safe relative links, current capability facts, and
   an appropriate changeset when shipped package files changed.

## Output format

Rank findings by severity and include:

- `file:line` or the task ID;
- the concrete input or lifecycle sequence that triggers it;
- the incorrect or risky behavior;
- the smallest safe fix;
- whether it blocks correctness, loses coverage, wastes tokens, or is only a
  documentation concern.

End with a short topology summary and a list of verified strengths. If no
finding is reproducible, say so and state which paths were checked.

## References

- Use [the review checklist](../workflow-authoring/references/review.md) for
  the compact acceptance gate.
- Use [lifecycle](../workflow-authoring/references/lifecycle.md) for pause,
  stop, budget, retry, and resume semantics.
- Use [debugging](../workflow-authoring/references/debugging.md) to reduce a
  failure to a deterministic fake-agent reproduction.
- Use [the generated capability index](../workflow-authoring/references/capabilities.md)
  only when a signature or support boundary is disputed.

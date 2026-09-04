---
name: workflow-patterns
description: Choose and run one of Pi's built-in multi-agent workflows for research, adversarial review, code review, multi-perspective analysis, or codebase auditing. Use when the request matches a named pattern; use workflow-authoring instead for a new script or custom topology.
metadata:
  version: "1.7.1"
---

# Built-in workflow patterns

Use a built-in when its input shape matches the request. The built-ins are
reviewed scripts with bounded fan-out, structured intermediate results, and a
final aggregation step. Prefer them over writing a new script for a standard
research or review task.

## Choose by task shape

| Request | Pattern | Input |
| --- | --- | --- |
| Investigate a question with cross-checked sources | `deep-research` | `{ question, angles?, minSupport? }` |
| Test a claim or task with skeptical reviewers | `adversarial-review` | `{ task, reviewers?, threshold? }` |
| Review a diff or change set from multiple angles | `code-review` | `{ diff, diffSource? }` |
| Compare a topic from independent viewpoints | `multi-perspective` | `{ topic, perspectives? }` |
| Assess codebase health, risk, and debt | `codebase-audit` | `{ scope?, root?, focus?, checks? }` |

Do not use a built-in for one direct question, one simple delegation, or a
custom dependency graph. Use the ordinary agent tool for small work and load
[workflow-authoring](../workflow-authoring/SKILL.md) for custom scripts.

## Invocation contract

The model-facing call is a `workflow` tool call, not JavaScript:

```json
{
  "name": "deep-research",
  "args": { "question": "What are the trade-offs between X and Y?" },
  "background": true
}
```

`name` resolves a saved workflow before the built-in. A saved workflow with the
same name intentionally overrides the built-in. Do not send `script` together
with `name`; choose one form. `background` defaults to `true`; use
`background: false` only when the caller needs the result inline or a human
checkpoint must be shown.

## Input rules

- `deep-research` requires a non-empty `question`; `angles` and `minSupport`
  should be small positive bounds appropriate to the question.
- `adversarial-review` requires a non-empty `task`; use reviewer counts and
  thresholds that fit the risk rather than maximizing votes.
- `code-review` requires the actual diff. Obtain it first with the host's safe
  diff path; do not ask the workflow to guess which files changed.
- `multi-perspective` requires a non-empty `topic`; provide at least two
  distinct perspectives when overriding the defaults.
- `codebase-audit` accepts a scope/root and optional focus/check list. Keep the
  scope narrow enough that every worker can inspect it and cite concrete paths.

## Result and recovery rules

Every built-in returns a bounded aggregate of successful intermediate results
and a final report. Failed worker calls can remain `null` or be omitted from that
aggregate, but stay visible in run details. A background call returns a run ID
immediately; inspect it with `workflow_control` (`get`, `pause`, `resume`, or
`stop`) rather than starting a duplicate run. If a provider limit pauses the run, resume the same
run after the configured retry window. A changed script or saved workflow
replays only its unchanged journal prefix, so preserve the original inputs when
resuming.

Inspect run details for missing or `null` worker results before treating the
aggregate as complete. State when sources, review angles, or audit dimensions
were unavailable; a settled workflow may still contain incomplete evidence.

## Built-in topology summary

- Research plans queries, gathers them concurrently, cross-checks claims, then
  writes a cited report.
- Adversarial review separates finding generation from skeptical verification
  before consensus.
- Code review fans out correctness, reuse, simplification, efficiency,
  architecture, security, and testability lenses, then verifies candidates
  before ranking them.
- Multi-perspective analysis runs independent views behind a barrier before
  synthesis.
- Codebase audit maps structure first, then runs bounded dimension audits before
  its roadmap.

When a built-in needs a dependency beyond these shapes, author a custom
`orchestrate()` graph instead of adding hidden assumptions to a built-in.

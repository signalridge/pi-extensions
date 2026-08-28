# Open decisions

Three questions this repository cannot answer for itself are followed by one
completed reference review. The questions are written up rather than acted on,
because each is a policy or ownership choice rather than a defect: implementing
any of them unilaterally would decide something the maintainer has not decided.

Each section states the current state, the options, and a recommendation. None
is blocking; the code is coherent as it stands under every option below.

---

## 1. Per-call worktree isolation (protocol change)

**Current state.** Worktree isolation exists and is thorough —
`pi-subagents/src/worktree.ts` handles creation, cleanup, and cleanup forensics.
It can only be triggered by an agent's own frontmatter (`isolation: worktree`),
because `ManagedSpawnPolicy` carries no `cwd` and the wire request has no
isolation field. A workflow that wants an isolated agent must therefore point at
an agentType that declares isolation, rather than asking for it per call.

This is a real divergence from the upstream orchestrator, which isolates
per call. It is documented as intentional in `pi-workflows/README.md`.

**The options.**

- **Leave it (status quo).** Isolation stays agent-owned. A workflow expresses
  "isolated" by choosing an agent, which is a coarser but perfectly usable
  handle, and no protocol version moves.
- **Add it.** The managed-spawn request gains an optional `isolation` field,
  gated behind a new capability flag. That is `PROTOCOL_VERSION` 3 → 4, and a
  **major** release of both `pi-subagents-protocol` and `pi-subagents`.

**What it would cost beyond the version bump.** Two things that are easy to get
wrong and worth writing down before anyone starts:

- worktree names must be `${runId}-${callIndex}-${label}` — **deterministic, no
  wall clock**. A name containing a timestamp changes between a run and its
  resume, so the resume's cache keys no longer address the same worktrees.
- every failure path must be a **logged no-op**. An isolation failure that
  throws turns a recoverable "this agent ran in the shared tree" into a failed
  workflow.
- it must route into the existing `worktree.ts`. A fourth worktree
  implementation in this repository would be one too many.

**Recommendation: leave it for now.** The status quo is not a gap so much as a
different place to put the same switch, and a double major on the protocol is a
large price for moving it. Revisit if a concrete workflow turns out to need two
different isolation answers from the *same* agentType — that is the case the
current design genuinely cannot express.

---

## 2. The dynamic-import rule

**Current state.** `AGENTS.md` says "Avoid dynamic imports and `any`". The tree
contains exactly ten dynamic imports, in five packages (`pi-btw` ×3,
`pi-recall` ×3, `pi-goal` ×2, `pi-codex-compact` ×1, `pi-stamp` ×1). Every one
of them is the same call:

```ts
const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
```

They are deliberate. The kit is a TUI library, and the import is deferred so
that headless, print-mode, and RPC paths — which never draw a menu — do not pay
to load it. That is a real benefit and the rule as written forbids it.

So the rule and the code disagree, and the code is right. The question is only
which one to change.

**The options.**

- **Narrow the rule.** Reword to something like: *"Avoid dynamic imports, except
  to defer loading a TUI-only dependency out of headless paths."* One sentence,
  no code changes, and the exception is narrow enough to stay meaningful.
- **Convert the ten call sites** to static imports and delete the exception.
  Simpler rule, but every extension then loads the TUI kit on every path,
  including the ones that will never render.
- **Leave both as they are.** Not recommended: a rule the codebase openly
  violates in ten places stops being read as a rule at all, which costs more
  than either fix.

**Recommendation: narrow the rule.** The exception is specific, it has a stated
reason, and it is already the design. Writing it down makes the remaining
prohibition mean something again.

---

## 3. Seven proposed new packages

**Current state.** Not started, deliberately. The proposals are `pi-review`,
`pi-session-query`, `pi-gate`, `pi-import-cc-codex`, `pi-raw-paste`,
`pi-caffeinate`, and `pi-tool`.

**Why this is a decision and not a task.** Each new package is a permanent
maintenance surface: a version line, a changeset discipline, a peer-range entry
in the shared-dependency check, a README that ships in a tarball, and a place in
the release ordering. Twenty-seven packages is already a lot to keep honest;
seven more is a ~26% increase in that overhead, taken on before any of them has
a user.

**One hard constraint, whatever is decided.** `/import` is a native Pi command.
`pi-import-cc-codex` **must not register it** — registering over a host command
is not a name clash this repository can win, and the existing name-clash guard
in `pi-workflows` (`pi.getCommands?.()` before registering) is the pattern any
new package should follow.

**Also worth noting:** `pi-gate` overlaps with what now ships as the `gate:`
frontmatter field in `pi-subagents`, where a host-run command's verdict is
attached to an agent's result. If a separate package is still wanted, its scope
should be stated against that, not alongside it.

**Recommendation: decide them individually, not as a batch,** and only when
there is a specific use for one. Nothing else in the roadmap depends on any of
them.

---

## 4. Workflow orchestration reference review

External coding-agent implementations suggest two complementary patterns:

- A script/engine seam with worker isolation, explicit fatal-vs-child-failure
  classification, paired lifecycle events, and bounded cancellation. A simple
  `parallel()`/`pipeline()` API is useful, but does not by itself provide named
  dependencies, durable nested runs, or provider-aware recovery.
- A subagent batch with ordered per-item outcomes, background controls, and
  adaptive admission after provider rate limits. This is useful for homogeneous
  batches, but it is not a general dependency graph and needs provider-specific
  rate-limit signals.

The package adopts the safe subset: named dependency graphs with deterministic
layer barriers, status-aware results, bounded task retries/failure policies,
whole-batch fatal barriers, and a replayable nested-workflow boundary. Worker
isolation and provider-specific adaptive scheduling remain separate follow-up
seams because adding them without changing ownership and lifecycle contracts
would make recovery less honest, not more capable.

# Changelog

## 1.5.0
### Minor Changes

- c1b1741: Protocol v4: workflows use the Agent-tier catalogue directly.
  
  The wire contract changes, so the three packages move together: `pi-workflows`
  now declares `"@signalridge/pi-subagents": ">=1.9.0"`, and a peer outside that
  range fails the startup handshake with a diagnostic naming both packages rather
  than failing mid-run.
  
  The `small | medium | large` workflow-tier vocabulary and its mapping layer are
  gone. A managed request names an Agent tier — a key in the host's own
  `agentTiers` catalogue — and `resolveAgentTier()` is the single resolver for
  every spawn path. Removed with it: the wire's mapped `agentTier` field, the
  `workflow` settings key (retired with a warning naming it; `agentTiers.defaultTier`
  replaces `workflow.defaultTier`), and the per-call `model`/`thinking` selectors,
  which the validator now rejects rather than accepting and ignoring.
  
  Every v4 capability is required and every ping carries the host's tier catalogue,
  so an incomplete peer fails one check instead of five optional ones. Fresh
  installs ship `low`/`medium`/`high` profiles, all inheriting their model, and a
  managed call that names no tier falls back to `medium`, so a workflow runs on an
  unconfigured machine without this package choosing a vendor. Because `medium`
  inherits, that fallback lands on the parent session's model — it commits to an
  effort level, not to a vendor, so it does change the thinking level a managed
  call runs at when the parent session is set higher, and it does not move the
  work anywhere cheaper. What it buys is a named policy with a durable snapshot
  and a scope check; a workspace that wants cheaper managed work names a
  `defaultTier` whose profile pins a model. The fallback is scoped to calls that
  cannot inherit a parent model rather than being installed as
  `agentTiers.defaultTier`: a shipped catalogue default would have applied to
  every ordinary `Agent` spawn as well, silencing `defaultModel` and pinning a
  thinking level on machines that configured neither. The catalogue no longer
  ships a `fast` profile; it was the same (model, thinking) pair as `low`, and the
  one agent that named it (Explore) now names `low`. A user agent file that still
  says `agentTier: fast` is reported by the existing unknown-reference check when
  settings and agents load, rather than failing at its first spawn.
  
  `agentTiers.defaultTier` therefore has three states, and `/agents → Settings`
  offers all three rather than rendering two of them as one word: a named tier,
  `unset` (managed calls reach the shipped fallback), and `none` (recorded as
  `noDefaultTier`, which withdraws the fallback so managed calls fail closed).
  `setDefaultAgentTier` takes that choice as a tagged value, so a caller cannot
  express "no default" without saying which of the two it means.
  
  `resolveAgentTier` gained `requireTier` for that fallback, and the two things
  pre-resolution callers need are both answered by the resolver rather than
  restated beside it: `agentTierApplies()` for "will a tier own this spawn's
  model?", and `selectAgentTier()` for the tier key itself, which the managed
  path needs to label a tombstone and the lifecycle events before the runner has
  resolved anything.
  
  Because a tier now owns model resolution outright, the spawn paths stop
  pre-resolving one — and with it they stopped producing the model name the agent
  UI shows. The resolution callback carries that label back instead, so a tier
  that pins a model still names it in the viewer and the agent list, and a profile
  that inherits correctly shows none. The label rides beside the snapshot rather
  than inside it: the snapshot is a durable policy record a managed tombstone
  persists and revalidates, and a cosmetic string does not belong in it.
  
  Workflow resume now keys each cached call on the policy for that call's own tier
  rather than on a whole-catalogue fingerprint, so defining or editing an unrelated
  tier no longer forces a full re-execution — but only for a call that names its
  tier. A call that names none keeps the whole-catalogue key, because the host
  resolves those as `call > agent frontmatter > defaultTier` and frontmatter is
  not on this wire: an agent reaches a managed caller as a name. Keyed on
  `defaultTier`, such a call would be wrong twice over — replaying stale work
  after an edit to the tier its agent actually declares, and re-executing after an
  edit to a default it never reached. `agentTierPolicyIdentity()` therefore
  requires a tier rather than accepting `undefined` and folding the default in, so
  the wrong call cannot be written. Journal schema v4 and managed tombstone schema
  v2 are quarantined from older facts rather than migrated.
  
  The tier catalogue belongs to the user, names included. The built-in workflows
  and the ad-hoc script ship with this package, so a tier name they use that the
  host does not define is dropped in favour of the host's default rather than
  failing the run — they cannot assert which names exist on someone else's
  machine. A script the user wrote still fails closed on an undefined tier, since
  that is a typo in a catalogue they own. Shipped-ness travels with the script
  rather than with the frame that called it, so a user script that reaches a
  built-in through `workflow(name)` applies the built-in's rule to the built-in;
  the authoring skill now says outright that `low`/`medium`/`high` are the shipped
  profiles rather than names an authored script may assume.
  
  The managed routing policy published on the wire reports the default a managed
  call will actually get, fallback included, so a peer's replay identity cannot
  disagree with the host's selection; its sorts are code-unit rather than
  locale-dependent, so the same catalogue fingerprints identically everywhere. The
  workflow peer re-pings per start and resume instead of pinning the catalogue it
  saw at session start, and reports the host-selected tier back through an
  `onTierResolved` callback rather than by mutating the dispatch options.
  
  Fixes: a nested spawn no longer relabels an agent's frontmatter tier as
  caller-requested, which had turned a `scopeModels` warning into a refusal and
  misattributed the choice; the scheduler no longer freezes a frontmatter tier into
  a job, so editing the agent file takes effect at fire time; retired managed spawn
  keys are now bounded instead of growing for the life of a session; a
  scope refusal for a tier whose profile inherits its model now names the model
  that would have run instead of the literal `undefined`; and the retired
  `workflow` key warns once per process rather than on every settings read and
  every project write.
  
  The tier-key predicate and its length bound now have a single definition, in
  `pi-subagents-protocol`, which `pi-subagents` re-exports. The wire is the
  narrower of the two gates — a key one accepted and the other rejected could
  never reach a peer — so a second copy could only ever be a way for them to
  disagree. That one definition now also governs `blockedProfiles`, which was
  being validated by a helper that trims first: `" low"` became `"low"` there
  while the same value in `profiles` or `defaultTier` was refused outright. All
  three reject.
  
  `/agents → Settings` no longer names the fallback tier in the `unset` row's
  label. Which tier `unset` reaches depends on the catalogue, and a workspace that
  edits or deletes the shipped `medium` profile leaves it reaching nothing — at
  which point `unset` and `none` behave identically. The row's description asks
  the resolver what `unset` would currently resolve to and says that, including
  when the answer is "nothing".
  
  `pi-workflows` also gained the session-lifecycle handling this routing work
  needed to sit on. The engine has an explicit dispose lifecycle, so a protocol
  probe or a start that is in flight when a session ends rejects with a disposed
  error instead of resolving against an engine nobody owns. The tool, command and
  widget surfaces register exactly once and resolve the *current* engine on each
  use, rather than closing over the one that existed when they were registered —
  a session replacement previously left them pointing at a disposed engine. Tool
  and command handlers report failures as results rather than throwing out of the
  host's dispatch, and the lifecycle handler accepts `subagents:created` and
  `subagents:started` so a spawn's identity is recorded from the first event that
  carries it rather than only at completion.

### Patch Changes

- Updated dependencies [c1b1741]
  - @signalridge/pi-subagents-protocol@1.4.0

## 1.4.0
### Minor Changes

- 28c8aa1: Strengthen script orchestration with deterministic named dependency graphs, bounded task retries and failure policies, safer fan-out barriers, durable nested-workflow replay, and reliable pause/resume accounting. The natural-language `/workflows run` path now plans, executes, and synthesizes a bounded task graph, while expanded authoring/pattern guidance and the new `workflow-review` skill make routing, recovery, and publication constraints explicit.

## 1.3.2
### Patch Changes

- 07350d4: Use the theme's `borderAccent` color for extension-owned outer borders so the popup and welcome-card framing follows the purple Signalridge palette.

## 1.3.1
### Patch Changes

- 7d2c6c9: Keep generated workflow capability references synchronized when Changesets versions the package.

## 1.3.0
### Minor Changes

- bae8689: Complete the managed workflow parity and hardening pass. Workflows now forward and validate exact model/thinking, toolset, denylist, thread, and per-call worktree intent while pi-subagents remains the policy and lifecycle owner. Script resume accepts edited revisions, workflow removal is durable, stale lifecycle events are rejected, provider-limit errors pause runs, and the live progress/effort/trigger settings are persisted and bounded. Run identity is durable before dispatch, pause/dispose stop owned agents and reject waiters, and every background start/resume delivers its result. The protocol adds only optional fields and capability metadata, preserving older policy-free managed-spawn consumers; workflows fail closed with a diagnostic when the peer does not advertise managed policy support.
- b6cf242: Rewrite `pi-workflows` from a declarative DAG engine to a JavaScript orchestration runtime.
  
  - **Scripts, not DAGs**: a workflow is now a raw JavaScript module executed in a determinism-guarded `node:vm` realm. The script declares `export const meta = { name, description, phases }` first and uses runtime globals `agent()`, `parallel()`, `pipeline()`, `workflow()`, `verify()`, `judgePanel()`, `loopUntilDry()`, `completenessCheck()`, `retry()`, `gate()`, `checkpoint()`, `phase()`, `log()`, `args`, `cwd`, restricted `process`, and `budget`. The `workflow` tool takes `script`/`name`/`args`/`background`/`maxAgents`/`concurrency`/`agentRetries`/`tokenBudget`/`agentTimeoutMs`/`resumeFromRunId` instead of `tasks`/`phases`/`synthesis`.
  - **Determinism guardrail**: `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable (regex precheck plus in-realm stubs); `new Date(arg)`, `Date.UTC`, and `Date.parse` still work. The meta contract rejects spread, computed keys, methods, template interpolation, and `__proto__`/`constructor`/`prototype`.
  - **Resume with cache replay**: an edited script replays the longest unchanged prefix from the journal (zero tokens for replayed calls) and runs live from the first changed or inserted call. Journal schema v2→v3: `run_created` carries the script text, hash, and meta; call identity is the lexical call index; each completed `agent()`/`checkpoint()` call journals `{ index, runId, callHash, result, storeDelta }`. Schema-v2 (declarative) journals are quarantined rather than replayed.
  - **Spawn-key generation rotation (A4)**: live dispatches use `${runId}/call-${callIndex}/attempt-${generation}`; a resume of an edited call rotates the generation so pi-subagents never raises a fingerprint conflict. Per-call store deltas replay additively in call order.
  - **Command surface expanded to 11+**: `/workflows` now supports `run`, `status`, `watch`, `stop`, `pause`, `resume`, `rm`, and `save <name> [runId]` subcommands; new `/workflows-models`, `/workflows-trigger` (persisted keyword arming via an input hook), `/workflows-progress`, `/effort`, `/ultracode`, the five built-in workflow commands (`/deep-research`, `/adversarial-review`, `/code-review`, `/multi-perspective`, `/codebase-audit`), and one command per saved workflow registered at `session_start` with name-clash checks. `stop` and `rm` are destructive and take no implicit target — a bare `/workflows rm` asks for a run id rather than acting on the first listed run; the reversible `pause` and `resume` still default to it. Each builtin command routes its free text to the `args` key its own script reads (`question`, `task`, `topic`, `scope`) rather than a generic `prompt` no script consumes, and a builtin whose name another extension already registered is skipped rather than clobbered, since Pi cannot unregister commands.
  - **`/code-review` resolves its own diff**: no argument auto-scopes `git diff HEAD` with generated and vendored artifacts excluded; a numeric argument reads `gh pr diff <n>`; an argument containing `..` reads that revision range; anything else is a path. It degrades to the unscoped `git diff HEAD` when the auto scope fails or when the exclusions emptied a non-empty diff, reports a genuinely clean tree as clean rather than as a degradation, and caps the diff before handing it to the review agents. Commands run as argv arrays, never shell strings.
  - **Keyword arming authorizes the tool rather than opening UI**: typing the bounded word `workflow`/`workflows` annotates the message to tell the model the `workflow` tool is available for this turn, with an explicit escape hatch so a conversational or trivial turn is still answered directly. Matching uses token boundaries that treat identifier, path, and flag punctuation as part of the token, so `myworkflow`, `workflow_name`, `WorkflowEngine`, `--workflow-id`, `src/workflow-editor.ts`, `workflow.ts`, and the `/workflows` command never arm — while a sentence-ending dot ("run a workflow.") still does. `/workflows-trigger` takes `set <word>` (matched exactly; only the default word also matches its plural), `off`, and `on`. Extension-submitted text never arms, and an already-annotated message cannot stack a second directive.
  - **Saved workflows (A7)**: project scope takes precedence over user scope, persisted under the package-owned workflow directories with atomic writes and backups; nested `workflow(savedName, args)` calls are one level deep.
  - **UI (A10)**: the navigator renders runs → phases → calls → detail; a live widget shows active runs and clears when idle; background-run results deliver through a session-bound endpoint, falling back to a durable marker when no endpoint is bound yet. Child-agent output still passes through `safe-text.ts` before truncation.
  - **Capability contract (A11)**: a machine-readable declaration is the single source of truth for the runtime surface; the runtime validates its bindings against it at run start, so docs and reality cannot drift.
  
  Intentional adaptations from upstream (documented in the README): no host-side web tools (agents reach the web via configured tools / MCP), no duplicate agent registry (agentType resolves in pi-subagents), and no second model-tier catalogue (tier routing uses pi-subagents' `workflow.tiers`). The managed protocol now carries optional exact model/thinking, toolset, denylist, thread, and worktree requests while pi-subagents retains final policy ownership.

### Patch Changes

- b6cf242: Peer dependency ranges now name the versions actually validated against, so an untested host combination fails at install time instead of silently at runtime: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core` move from `"*"` to `^0.84.0`, and `typebox` from `"*"` to `^1.3.11`.
  
  Shared dependencies now carry ONE declared range across every package that uses them, and `bun run check:shared-deps` keeps it that way.
  
  `@narumitw/pi-tui-kit` was declared at three disjoint floors — `^0.54.0`, `^0.51.0`, and `^0.49.1` across nine packages — and the lockfile duly resolved three copies (0.54.0, 0.51.0, 0.49.3) installed side by side. For a shared rendering surface drawing into one terminal inside one host process, that means a theme rendering one way in one extension and another way in the next, with nothing failing at install to say so. All nine now declare `^0.54.0` and the install resolves a single copy. `@sinclair/typebox` likewise converges on `^0.34.50`.
  
  The new check covers `dependencies` and `peerDependencies` and compares range strings rather than their semantics: two ranges that merely overlap are still a finding, because the goal is one intentional answer per dependency rather than an accidental intersection. `devDependencies` are deliberately out of scope — a build tool is not a shared surface, and `pi-subagents` intentionally carries its own toolchain. `docs/package-boundaries.md` documents the Kit as a shared surface for the first time.
- Updated dependencies [bae8689]
  - @signalridge/pi-subagents-protocol@1.3.0

## 1.2.1
### Patch Changes

- 24a8af4: Remove references to the maintainer's personal dotfile setup from shipped docs
  and source comments. Each constraint is restated as a property of the package
  itself: which manager owns a settings file, whether a project permits git
  worktrees, and installing a package from a single source. No runtime behavior
  changes.

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

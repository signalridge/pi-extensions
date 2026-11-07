# Package boundaries

This repository keeps Pi extensions independently publishable. Packages communicate
through Pi's public APIs and `pi.events`; no extension imports another extension's
source. Shared wire validation lives in `@signalridge/pi-subagents-protocol`, a
library dependency that is not a Pi resource and must not be added to `settings.json`.
The same resource-free rule applies to `@signalridge/pi-ui`.

## Ownership matrix

| Area | Owner | Contract / boundary |
| --- | --- | --- |
| Footer | `pi-statusline` | Owns footer rendering, presets, and statusline settings. It consumes Pi lifecycle state and bounded status snapshots; it does not persist analytics or mutate another package's settings. |
| Input editor | `pi-input-prefix` | Installs the synchronous themed editor base and owns `PI_INPUT_PREFIX`. |
| Input history | `pi-input-history` | Decorates the current editor factory and owns history persistence/search. It must call the current factory so registration order remains safe. |
| Terminal title | `pi-tab-status` | Owns terminal title state, `PI_TAB_STATUS_STYLE` and the opt-in `PI_TAB_STATUS_NOTIFY` desktop notifications; it is TUI-only and does not own the footer or Pi's native OSC 7501 program status. Use one desktop notifier per session. |
| Startup card | `pi-welcome` | Owns one additive `welcome-card` transcript entry. Pi owns native startup/resource diagnostics. |
| Away recap | `pi-session-recap` | Owns recap presentation and bounded transcript-derived context; it does not become a second session store. |
| Session checklist | `pi-todo` | Owns revisioned current-branch snapshots, its manual overlay and status key; completion is a checklist assertion, not execution evidence or shared task claiming. |
| Secret obfuscation | `pi-secrets` | Owns `pi-secrets.json`, its per-install `pi-secrets.key`, the provider-bound placeholder rewrite in `context_with_system`, placeholder restoration in `tool_call` and `/secrets`. It never mutates stored entries and does not cover the system prompt, tool definitions, compaction requests or other extensions' side requests. |
| Rule files | `pi-rules` | Owns rule discovery, the `pi_rules` prompt section, `read_rule`, `/rules`, its `pi-rules:delivered` branch entries and hidden `pi-rules:reminder` messages. It does not own context files (`AGENTS.md` and provider files stay with Pi and `pi-agent-guidance`) and is not a permission policy. |
| Session navigation/handoff | `pi-sessions` | Owns explicit preview/consent and editable summary transfer through native replacement; it does not replace native history, change process cwd or send the destination draft. |
| Usage UI | `pi-usage-extension` | Owns usage views/export commands. It consumes usage records and does not define analytics storage rotation. |
| Analytics | `pi-analytics` | Owns its experimental analytics files, generation rotation, and queries. |
| Transcript metadata | `pi-stamp` | Owns timestamp/tool-timing metadata entries and their bounded format. |
| Active worktime | `pi-worktime` | Owns per-session active-span accounting, the `worktime` status key, and validated `worktime:update` payloads; status updates are TUI-only and consumers must not clear or reinterpret its state. |

No extension starts a run on its own initiative — a completion notice, background
wake, workflow delivery or goal continuation — while an unrecovered context
overflow remains on the branch. Only a later successful assistant response or
compaction ends the episode; aborted responses and transient provider errors do
not establish recovery. Such a run cannot succeed and is billed for the whole oversized context. The content is still
delivered without triggering a turn, one notice per overflow episode tells the
user to compact or start a new session, and normal waking resumes after a
compaction. Each package implements this check locally from Pi's
`isContextOverflow`.

Each UI package may listen to native Pi lifecycle events, but custom event payloads
must be validated at the consumer boundary. A package may publish a status key only
for state it owns; renderers consume keys and never overwrite the producer's state.
`pi-worktime` publishes only finite, nonnegative `{ ms, running }` payloads on
`worktime:update`; `pi-statusline` or another renderer may consume the owned
`worktime` status generically but must not mutate it. TUI behavior checks
`ctx.mode === "tui"`; dialogs additionally require `ctx.hasUI`.

## Orchestration

| Owner | Owns | Must not own |
| --- | --- | --- |
| `pi-subagents` | Managed child sessions, model/thinking/tool/skill policy, queue, concurrency, retry, cwd/isolation, transcripts, stop, quiescence, managed lifecycle records, and opt-in ordinary parent clarification for background children. | Workflow DAG state, workflow journal interpretation, or automatic permission/credential/destructive-action approval. |
| `pi-workflows` | DAG validation/scheduling, `pi-workflows:journal`, run/task transitions, recovery identities, synthesis, bounded control output, and workflow-owned event filtering. | Subagent settings, execution policy, raw child-session lifecycle, or unowned stop fallback. |
| `pi-goal` | Goal state, goal persistence, goal-owned continuation/settled lifecycle, and bounded-flow tool policy. | Workflow journal or subagent queue policy. |
| `pi-ralph-wiggum` | Ralph loop state and session-boundary behavior. | Goal state and managed subagent policy. |

The managed RPC is versioned and capability-gated. Every managed request and
lifecycle event is scoped by `{ extension, runId, nodeId, attemptId }`. Workflow
execution is disabled when the required peer is absent, duplicated, or advertises
an incompatible protocol. Owned cleanup requires `ownedStop` and `ownedQuiescence`;
there is no unowned stop fallback. The optional main-agent clarification channel
belongs to the subagent owner, does not widen parent-history sharing, and leaves
human approval gates unchanged. It is not a second managed RPC or an arbitrator
agent.

Workflow author JavaScript and callbacks execute in owned Node helpers. Native
bindings, managed child dispatch, execution policy, budgets and durable journal
facts stay parent-owned. A helper returning a value is not proof that accepted
native operations or descendant execution frames are quiescent.

## Choosing capabilities

Use the [portfolio selection rules and capability tables](extension-portfolio.md#selection-rules) to choose extensions and alternatives, rather than enabling everything.

Goal owns objective completion; Ralph owns file-backed iterations. Ralph follow-ups are not Goal-owned automatic responses: budgets and stop/completion states remain independent, and neither budget caps the combination. Prefer one main-session continuation controller per task; Goal with a finite Workflow gives a clearer objective/orchestration/execution hierarchy.

## Background processes

`pi-background` owns its local shell process groups, bounded in-memory logs,
literal-match watches, and session-local notification outbox. It does not replace
builtin `bash`, own remote workspace execution, spawn agents, or mutate Goal state.
Session shutdown and successful session-tree navigation terminate owned jobs and
discard logs/outbox state. There is no persistence or cross-extension process-control
protocol. The optional [status-action UI contract](status-navigation.md) only admits
explicit user navigation to the owning extension's view; it grants no job-control
or execution authority. Permission policies must cover its launch tools separately from `bash`.
Attaching a watch to an existing job is not a new command launch.
Asynchronous events are recorded without a turn, then a bounded extension-sourced
user message takes the normal prompt-hook path. This does not resume Goal state.
Managed subagent sessions exclude `pi-background`: process-driven child turns
cannot outlive their manager's completion or isolated-workspace cleanup.

## Persistence boundaries

- `pi-workflows:journal` is appended through `pi.appendEntry` and is not included
  in model context. It contains only workflow facts: dispatch/attempt identity,
  transitions, results, compaction counts, recovery rotations, terminal cleanup,
  and synthesis results.
- `pi-subagents` owns its managed spawn/tombstone records and is the only package
  that interprets them as child-session facts. Workflow recovery may consume a
  validated managed inspection response, but must not make subagent storage its
  durable schema.
- `pi-goal` owns its goal state files and pending continuation intent.
- `pi-analytics` owns its generation files and lock-free rotation markers.
- `pi-stamp` owns transcript metadata entries.
- `pi-todo` owns `pi-todo:state` snapshots on the current native branch. File-backed
  mutation requires a real persisted conversation and positive verification of
  the exact committed record. Uncertain append outcomes are quarantined; native
  memory ghosts are not recovered as successful commits. Explicit in-memory
  sessions are volatile. This is not an fsync or cross-process transaction.
- `pi-sessions` keeps native session history authoritative. Its non-model handoff
  record contains the approved summary and parent link, plus optional model/hash
  prefill intent, never a raw unsent draft. Exclusive private native snapshots
  preserve unsaved parents; custom-only destination recovery is explicitly
  materialized and reopened through public APIs, without a synthetic model turn.
- `pi-rules` records each delivered reminder or block as a `pi-rules:delivered`
  entry on the current branch and recomputes its repeat policy from that branch,
  so reload and resume do not repeat a delivery and `/tree` re-arms it on a
  branch where it never fired.
- `pi-agent-guidance` records each delivered subdirectory context file on the
  current branch and reads the compaction-aware branch view, so compaction,
  `/tree` or a changed file delivers it again.
- User sessions, permissions, keybindings, auth, workflow projects, and legacy
  workflow settings remain user-owned data during migration.

For workflow journal persistence, a retryable append failure keeps the in-memory waiter and immutable mutation alive;
it never reports success before the durable append completes. Recovery IDs are
deterministic, exact duplicates are no-ops, and conflicting IDs are quarantined.
Terminal state is published only after owned children, managed dispatches,
lifecycle callbacks, synthesis, cleanup, and the terminal journal append settle.

## Policy and developer integrations

`pi-plan-mode` owns read-only command policy, plan persistence and the opt-in
implementation-model handoff; it restores the planning model only when the live
model is still the one it applied, and does not compete with Subagents tiers or
virtual-model routing. `pi-worktree`
owns repository-scoped locking, identity verification, quarantine, and safe Git
mutation. It remains opt-in because worktree creation changes repository state
and requires an explicit ownership and cleanup policy.

`pi-lsp`, `pi-github-pr`, `pi-files-widget`, `pi-code-actions`, `pi-btw`, and
`pi-recall` each own their tools, schemas, bounded output, and TUI guards. They do
not become a shared developer-tool coordinator. Shared UI framing is intentionally
owned by `@signalridge/pi-ui`: it only adapts Pi's public custom-component boundary,
does not own extension state or menu semantics, and is used when multiple packages
need the same visual contract.

`pi-btw`'s opt-in `advisor` tool is the model-invoked counterpart of its human
side questions: one configured reviewer model, no tools in the reviewer request,
no availability in non-UI or child sessions. It does not own continuation; the
main model decides what to do with the answer.

## Tool-call policy

`pi-rules` enforces rule files at `tool_call`: a `block` rule returns Pi's
`{ block: true, reason }`, a `remind` rule lets the call run and steers a hidden
reminder after it. Pi stops at the first handler that blocks, so load `pi-rules`
before a permission extension that prompts a human: otherwise a person can
approve a call that a rule then refuses. Rules are guidance enforced on matching
input, not a permission policy, sandbox or substitute for project trust; project
rule files load only in trusted projects. Permission, approval and command
blocking belong to dedicated permission extensions, which must cover
`bash_background` and `monitor` as well as `bash`.

`pi-secrets` restores placeholders to real values in `tool_call`, so handlers
that load before it see placeholders and handlers that load after it see
values. Load it first when later policy (rules, permissions) must judge the
command that actually runs. Its outbound rewrite runs in `context_with_system`,
after every `context` handler regardless of load order, but in load order among
other `context_with_system` handlers: text that `pi-subagents` injects there for
pending parent questions is obfuscated only when `pi-subagents` loads first.

## Shared third-party surfaces

`@narumitw/pi-tui-kit` is a shared rendering surface, not an ordinary
dependency. Packages draw with it into the same terminal inside one host
process, so its agreed version is part of their combined behavior. Divergent
ranges can install separate copies without an install error and produce
inconsistent rendering or theme behavior.

The rule is therefore **one declared range per shared dependency**, enforced by
`bun run check:shared-deps` (included in `bun run check`) over `dependencies`
and `peerDependencies` in every package. A dependency is shared once at least
`MIN_PACKAGES = 2` packages declare it, so two packages agreeing on a floor
is already a contract. The check compares range strings, not their semantics:
two ranges that merely overlap are still a finding, because the goal is one
intentional answer per dependency rather than an accidental intersection. Host
peer ranges (`@earendil-works/*`) are covered by the same rule for the same
reason — a session loads every extension into one host, so packages naming
different host ranges are disagreeing about what they are running inside.

`devDependencies` are deliberately out of scope. A build tool is not a shared
surface, and `pi-subagents` intentionally carries its own toolchain: it is
excluded from both the root `tsconfig.json` and the root `biome.json` and runs
its own `typecheck`, `lint`, and `test` scripts. That exclusion is a deliberate
arrangement, not drift — it is also the repository's largest un-root-linted
surface, which is the cost that buys it.

## Package kind rules

Directories under `packages/` are either:

- a Pi extension with `piExtension.lifecycle` and non-empty `pi.extensions`; or
- an explicitly classified pure library with `signalridgePackage.kind: "library"`,
  no `pi.extensions`, no lifecycle listeners, no settings access, and no side
  effects at import time.

Libraries must expose only named, side-effect-free contracts and are included as
normal npm dependencies of the extensions that use them. A library may depend on
public Pi types or rendering primitives, but it must not register resources, listen
to lifecycle events, access settings, or perform import-time work. Libraries are
packed and published independently, but never listed in Pi's extension package map.

# Package boundaries

This repository keeps Pi extensions independently publishable. Packages communicate
through Pi's public APIs and `pi.events`; no extension imports another extension's
source. Shared wire validation lives in `@signalridge/pi-subagents-protocol`, a
library dependency that is not a Pi resource and must not be added to `settings.json`.
The same resource-free rule applies to `@signalridge/pi-approval-core`, which
provides local approval contracts and reviewed native-tool factories, not a
permission policy or an independently enabled extension.

## Ownership matrix

| Area | Owner | Contract / boundary |
| --- | --- | --- |
| Footer | `pi-statusline` | Owns footer rendering, presets, and statusline settings. It consumes Pi lifecycle state and bounded status snapshots; it does not persist analytics or mutate another package's settings. |
| Input editor | `pi-input-prefix` | Installs the synchronous themed editor base and owns `PI_INPUT_PREFIX`. |
| Input history | `pi-input-history` | Decorates the current editor factory and owns history persistence/search. It must call the current factory so registration order remains safe. |
| Terminal title | `pi-tab-status` | Owns terminal title state and `PI_TAB_STATUS_STYLE`; it is TUI-only and does not own the footer. |
| Startup card | `pi-welcome` | Owns one additive `welcome-card` transcript entry. Pi owns native startup/resource diagnostics. |
| Away recap | `pi-session-recap` | Owns recap presentation and bounded transcript-derived context; it does not become a second session store. |
| Session checklist | `pi-todo` | Owns revisioned current-branch snapshots, its manual overlay and status key; completion is a checklist assertion, not execution evidence or shared task claiming. |
| Human approval | `pi-approvals` | Owns per-operation human decisions, pending review UI and service leases; it does not grant tool admission, project trust or OS isolation. |
| Session navigation/handoff | `pi-sessions` | Owns explicit preview/consent and editable summary transfer through native replacement; it does not replace native history, change process cwd or send the destination draft. |
| Usage UI | `pi-usage-extension` | Owns usage views/export commands. It consumes usage records and does not define analytics storage rotation. |
| Analytics | `pi-analytics` | Owns its experimental analytics files, generation rotation, and queries. |
| Transcript metadata | `pi-stamp` | Owns timestamp/tool-timing metadata entries and their bounded format. |
| Active worktime | `pi-worktime` | Owns per-session active-span accounting, the `worktime` status key, and validated `worktime:update` payloads; status updates are TUI-only and consumers must not clear or reinterpret its state. |

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

## Background processes

`pi-background` owns its local shell process groups, bounded in-memory logs,
literal-match watches, and session-local notification outbox. It does not replace
builtin `bash`, own remote workspace execution, spawn agents, or mutate Goal state.
Session shutdown and successful session-tree navigation terminate owned jobs and
discard logs/outbox state. There is no persistence or cross-extension control
protocol. Permission policies must cover its launch tools separately from `bash`.
When `pi-approvals` is loaded, launch adapters capture its local service and wait
before starting a command; a captured broken/retired service cannot become an
unreviewed fallback. Attaching a watch to an existing job is not a new command
launch. This approval capability is not a cross-extension job-control API.
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
- `pi-approvals` retains bounded pending decisions in memory, never a reusable
  persistent grant. Session/branch retirement, changed input/file state and
  cancellation invalidate the specific operation.
- User sessions, permissions, keybindings, auth, workflow projects, and legacy
  workflow settings remain user-owned data during migration.

For workflow journal persistence, a retryable append failure keeps the in-memory waiter and immutable mutation alive;
it never reports success before the durable append completes. Recovery IDs are
deterministic, exact duplicates are no-ops, and conflicting IDs are quarantined.
Terminal state is published only after owned children, managed dispatches,
lifecycle callbacks, synthesis, cleanup, and the terminal journal append settle.

## Policy and developer integrations

`pi-plan-mode` owns read-only command policy and plan persistence. `pi-worktree`
owns repository-scoped locking, identity verification, quarantine, and safe Git
mutation. It remains opt-in because worktree creation changes repository state
and requires an explicit ownership and cleanup policy.

`pi-lsp`, `pi-github-pr`, `pi-files-widget`, `pi-code-actions`, `pi-btw`, and
`pi-recall` each own their tools, schemas, bounded output, and TUI guards. They do
not become a shared developer-tool coordinator. Shared UI framing is intentionally
owned by `@signalridge/pi-ui`: it only adapts Pi's public custom-component boundary,
does not own extension state or menu semantics, and is used when multiple packages
need the same visual contract.

## Human operation approval

`pi-approval-core` defines local version-1 query/lifecycle/adapter contracts;
managed protocol v4 and workflow journal v4 are unchanged. `pi-approvals` is the
opt-in human authority. Root canonical replacements require explicit
`--approvals-native-tools` certification that their backends are standard local
Pi tools; without it, original backends are not replaced and canonical mutations
are denied. Noncanonical command/mutation-shaped tools require a live cooperative
adapter matching the effective schema identity, not an assumed universal gate.

Managed children capture the root service before awaiting and install reviewed
implementations only for already admitted tools. Existing Plan policy, project
trust, child tool admission and `ask_tools` remain authoritative. Ordinary parent
clarification cannot approve an operation. Human review is explicitly opened with
`/approvals`; no model-callable approval responder is installed. RPC confirmations
use native transport nonces, not lifecycle request IDs. These controls serialize
cooperating same-process native mutations, not arbitrary external writers, remote
backends or unknown execution capabilities; they are not an OS sandbox.

## Shared third-party surfaces

`@narumitw/pi-tui-kit` is a shared rendering surface, not an ordinary
dependency. Nine packages draw with it into the same terminal, inside one host
process, so the version they agree on is part of how the extensions look and
behave together rather than an implementation detail of each.

That makes divergent ranges a real defect, and a quiet one. Declared at three
separate floors (`^0.54.0`, `^0.51.0`, `^0.49.1`), the lockfile resolved three
copies — 0.54.0, 0.51.0 and 0.49.3 — installed side by side. Nothing fails at
install; it surfaces later as a theme that renders one way in one extension and
another way in the next.

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

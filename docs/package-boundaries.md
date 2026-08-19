# Package boundaries

This repository keeps Pi extensions independently publishable. Packages communicate
through Pi's public APIs and `pi.events`; no extension imports another extension's
source. Shared wire validation lives in `@signalridge/pi-subagents-protocol`, a
library dependency that is not a Pi resource and must not be added to `settings.json`.

## Ownership matrix

| Area | Owner | Contract / boundary |
| --- | --- | --- |
| Footer | `pi-statusline` | Owns footer rendering, presets, and statusline settings. It consumes Pi lifecycle state and bounded status snapshots; it does not persist analytics or mutate another package's settings. |
| Input editor | `pi-input-prefix` | Installs the synchronous themed editor base and owns `PI_INPUT_PREFIX`. |
| Input history | `pi-input-history` | Decorates the current editor factory and owns history persistence/search. It must call the current factory so registration order remains safe. |
| Terminal title | `pi-tab-status` | Owns terminal title state and `PI_TAB_STATUS_STYLE`; it is TUI-only and does not own the footer. |
| Startup card | `pi-welcome` | Owns one additive `welcome-card` transcript entry. Pi owns native startup/resource diagnostics. |
| Away recap | `pi-session-recap` | Owns recap presentation and bounded transcript-derived context; it does not become a second session store. |
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
| `pi-subagents` | Managed child sessions, model/thinking/tool/skill policy, queue, concurrency, retry, cwd/isolation, transcripts, stop, quiescence, and managed lifecycle records. | Workflow DAG state or workflow journal interpretation. |
| `pi-workflows` | DAG validation/scheduling, `pi-workflows:journal`, run/task transitions, recovery identities, synthesis, bounded control output, and workflow-owned event filtering. | Subagent settings, execution policy, raw child-session lifecycle, or unowned stop fallback. |
| `pi-goal` | Goal state, goal persistence, goal-owned continuation/settled lifecycle, and bounded-flow tool policy. | Workflow journal or subagent queue policy. |
| `pi-ralph-wiggum` | Ralph loop state and session-boundary behavior. | Goal state and managed subagent policy. |

The managed RPC is versioned and capability-gated. Every managed request and
lifecycle event is scoped by `{ extension, runId, nodeId, attemptId }`. Workflow
execution is disabled when the required peer is absent, duplicated, or advertises
an incompatible protocol. Owned cleanup requires `ownedStop` and `ownedQuiescence`;
there is no unowned stop fallback.

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
- User sessions, permissions, keybindings, auth, workflow projects, and legacy
  workflow settings remain user-owned data during migration.

A retryable append failure keeps the in-memory waiter and immutable mutation alive;
it never reports success before the durable append completes. Recovery IDs are
deterministic, exact duplicates are no-ops, and conflicting IDs are quarantined.
Terminal state is published only after owned children, managed dispatches,
lifecycle callbacks, synthesis, cleanup, and the terminal journal append settle.

## Policy and developer integrations

`pi-plan-mode` owns read-only command policy and plan persistence. `pi-worktree`
owns repository-scoped locking, identity verification, quarantine, and safe Git
mutation. It remains opt-in because the user's repository constitution forbids
worktrees.

`pi-lsp`, `pi-github-pr`, `pi-files-widget`, `pi-code-actions`, `pi-btw`, and
`pi-recall` each own their tools, schemas, bounded output, and TUI guards. They do
not become a shared developer-tool coordinator. A future shared library is only
justified for a pure parser or wire contract whose semantics are demonstrably
identical in at least two packages.

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

Libraries must expose only named, dependency-free contracts and are included as
normal npm dependencies of the extensions that use them. They are packed and
published independently, but never listed in Pi's extension package map.

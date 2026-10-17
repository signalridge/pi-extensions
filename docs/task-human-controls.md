# Task and human-control implementation

Status: implemented on the feature branch. Run the integrated verification commands below against the exact source before merging. This acceptance ledger does not claim npm publication.

## Scope

1. Independent, opt-in session/branch Todo, distinct from an execution scheduler or project/shared backlog.
2. `Ctrl+Alt+B` opens the existing guarded background-task selector without consuming the subagent foreground handoff key.
3. Per-operation reviewed write/edit approval, not session-wide permission for subsequent writes.
4. Human-owned command approval across root, managed child and background launch paths.
5. Editable-summary linked-session handoff and cross-workspace preview/navigation, distinct from approved-plan implementation handoff.

No global installation/settings changes, default experimental activation, automatic conversion of builtin bash to background work, PTY attachment, SSH backend, memory subsystem or shared project backlog is included.

## Boundaries

- Use public Pi APIs and validated `pi.events` payloads. Extensions do not import each other's source; the intentionally shared approval contract lives in a side-effect-free library.
- Managed protocol v4 and workflow journal schema v4 remain unchanged. Ordinary parent clarification cannot approve execution.
- Approval binds to the exact owner, operation, effective cwd, final input and reviewed file state. Changed input/file state, missing approver, cancellation and retired ownership invalidate it. Review limits reject rather than clip changes.
- Permission controls are not an OS sandbox. Stricter tool admission, project trust and Plan policy remain authoritative. Noncanonical execution tools need explicit cooperative adapters; arbitrary extension-side I/O is outside this boundary.
- Reviewed edit operations use the native SDK mutation queue's computed output. Write mkdir is deferred until approval. This serializes cooperating same-process operations, not arbitrary external writers or independently loaded runtimes.
- Background approval belongs to the normalized launch and must remain valid through asynchronous startup, not merely when a human answers. Inspection alone starts neither a command nor a model turn.
- Reviewed bash retains the SDK tool/output layer but uses an owned POSIX backend, checking owner/service/admission after CWD preparation and at command IPC dispatch. Standalone Node.js with public SEA detection is required; Bun/compiled Pi, Node SEA and unknown capabilities reject before approval or subprocess startup. Edit/write do not require that bash-only runtime capability.
- Todo completion is a checklist assertion, not proof of workflow execution or successful verification. Never infer completion from prose, stops or partial results. Native incomplete ancestry must not silently become an empty checklist.
- Session preview does not authorize instructions in stored history. A handoff saves a human-approved summary outside model context and only prefills a draft; it never automatically submits a model turn. Retired source approval cannot grant a fresh destination prefill.

### Host-observation limits

Pi 1.0.4 dispatches cancellable lifecycle handlers in extension order and stops at the first veto. An extension cannot observe an attempt already vetoed by an earlier extension. Session ownership fences therefore cover **delivered lifecycle events and observable state changes**, not every possible navigation attempt.

RPC does not expose client-local draft contents, draft versions or conditional editor writes. A client must preserve newer local drafts and reject stale confirmations; an explicit Yes authorizes replacement of its current draft. Neither a branch fingerprint nor destination-owned consent supplies a missing client draft epoch. A universal stale-consent guarantee requires public host/client support, not private runtime patches.

Parent record/leaf equality is checked at handoff preflight. A reused native parent remains live history, not an immutable snapshot: later native appends can advance it, including during replacement hooks. Observable preflight revocation strips automatic editor-prefill authorization, but native replacement and its live parent link may still proceed with recovery-only data. A private snapshot records the captured branch when an existing file cannot represent it.

## Acceptance matrix

| Area | Required evidence |
| --- | --- |
| Todo state/recovery | Stable IDs/revisions; complete dependency validation; immutable snapshots; append failure and orphan ancestry; branch/fork/reload/compaction; bounded context and storage reads |
| Todo UI | Manual edit/status/reopen; distinct destructive confirmation; configured keys and encoded printable keys; paste/Undo/CJK safety; resize and draft/focus preservation |
| Background | Shortcut in fullscreen/regular modes; empty/running/finished selector; no Ctrl+B conflict; captured launch owner/service through filesystem and supervisor awaits |
| Reviewed mutations | Exact edit semantics and complete bounded diff; final arguments/file bytes; concurrent mutations; cancellation, retirement and no unreviewed fallback |
| Commands | Root/managed/background paths; partial and late canonical registration; final alias normalization; parallel human requests; absent/non-UI approver fails closed |
| Session storage | Bounded discovery/preview; malformed metadata and native payloads; real v2 migration; growing-file bounds; custom directories and explicit workspace consent |
| Handoff/UI | Editable exact summary; durable parent/intent; destination ownership; revoked preflight authorization; explicit recovery; paste Undo, remapped controls and asynchronous foreign focus |
| Composition/release | Plan/trust/ask-tools restrictions; exact-owned cleanup; independent manifests/Changesets; complete root gate, packed loaders and explicit external publication prerequisites |

## Reproducible verification

Run from the repository root with the lockfile's existing development dependencies. These commands use the checked-in harnesses rather than unavailable development-session scratch files:

```sh
bun run --cwd packages/pi-todo check
bun run --cwd packages/pi-approval-core check
bun run --cwd packages/pi-approvals check
bun run --cwd packages/pi-background check
bun run --cwd packages/pi-sessions check
bun run --cwd packages/pi-subagents check
bun run --cwd packages/pi-workflows check

# Actual offline Pi CLI/PTY UI checks; macOS/Linux and Python 3 stdlib required.
python3 packages/pi-background/test/shortcut-cli.py
python3 packages/pi-todo/test/prefill-cli.py "$(mktemp -d)"
python3 packages/pi-sessions/test/ui-cli-cleanup.py
python3 packages/pi-sessions/test/ui-cli.py "$(mktemp -d)"

# Final integrated gate; includes package, integration, packing/loading and secret checks.
bun run check
bun run --cwd packages/pi-subagents build
git diff --check
```

Package checks include unit and native SDK tests; the approvals suite also runs the actual RPC CLI transport. The two Python commands exercise actual CLI terminal input and UI fixtures. Session UI frames are public post-composition assertions with raw terminal output retained separately, not an independent physical-terminal or universal third-party-renderer certification. The sessions UI fixture does not constitute complete `/sessions` and `/handoff` command-level CLI acceptance. Managed-child SDK coverage is not separately exercised child CLI/TUI coverage.

Earlier development sessions recorded additional Todo CLI, session-command RPC/TUI/discovery and root/background approval-composition counts. Their external scratch harnesses are **not included in this checkout** and their continued availability is not asserted. Treat those counts as historical reports, not presently rerunnable acceptance or substitutes for the commands above. Current verification must identify its source revision, commands, exits, deadlines and retained results; do not replace a failed full gate with a passing diagnostic subset.

No live-provider, paid-inference, physical-terminal or universal third-party-renderer qualification is claimed. Native new/reload cursor reset and native fork draft-prefill behavior are host-owned; ordinary overlay preservation is tested separately without private cursor patches.

## Publication is a separate gate

The new package names `@signalridge/pi-approval-core`, `@signalridge/pi-approvals`, `@signalridge/pi-sessions` and `@signalridge/pi-todo` require registry verification, maintainer-owned first-name bootstrap when absent, and package-specific npm Trusted Publisher configuration. Public registry availability does not establish Trusted Publisher settings.

Coordinate these prerequisites before merging/releasing because existing adapters depend on the new core. Follow [the normal Changesets/OIDC release process](releasing.md). No local publish, token fallback, manual version bump, release-PR merge or global activation is implied by implementation or green code CI.

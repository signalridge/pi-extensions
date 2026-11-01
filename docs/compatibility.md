# Compatibility and verification

## Tested host and dependency ownership

The workspace development baseline is **Pi 1.4.0**, pinned exactly in the root
`package.json` and any package-local Pi development dependencies. A newer host
must pass its own acceptance run; a newer upstream release or a successful
individual test does not qualify the whole repository.

The baseline moved from 1.0.4 to 1.4.0 with a full acceptance run. Host
changes that extensions must account for since 1.0.4:

- `before_agent_start` is a union on `messageType` (Pi 1.2): `"user"` carries
  `prompt` and `images`, `"custom"` carries the `message` of a run started by an
  idle `pi.sendMessage(..., { triggerTurn: true })`, which earlier hosts never
  announced there. Code that keys on the prompt must skip custom runs; code
  that shapes every request (system prompt sections, tool policy) should not.
- The session counts as busy while its own run starts (Pi 1.2), including
  inside `before_agent_start`; `ctx.isIdle()` there no longer distinguishes
  "another run started meanwhile", and `pi.sendMessage()` queues into the
  starting run.
- Closing an overlay dialog removes only its own overlay (Pi 1.3); 1.0.4
  removed the topmost one. `Editor` and `Input` draw the cursor between
  invisible markers (pi-tui 1.2), which line sanitizers must admit.
- Interactive extension dialogs form a stack (Pi 1.3), and `/reload` disposes
  open dialogs without closing them; a dialog owner must settle on dispose.
- `Terminal.setProgramStatus()` (OSC 7501, Pi 1.1) and `durationMs`/`outputPad`
  on the tool render context are required members of their interfaces.

Host-provided modules belong in `peerDependencies` with the literal range `"*"`,
not runtime or optional dependencies:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`
- canonical `typebox` and legacy `@sinclair/typebox`

The wildcard identifies module ownership, **not compatibility with every Pi
version**. Pi maps the supported legacy TypeBox imports to its canonical
implementation. A second physical host runtime can bypass module identity and
produce duplicate classes, registries or initialization. The development
TypeBox pin follows the tested host.

Shared runtime/rendering dependencies use one declared range across packages.
See [package boundaries](package-boundaries.md) for ownership and persistence
contracts and [design decisions](open-decisions.md) for implementation constraints.

## Runtime contracts

- Guard custom terminal components with `ctx.mode === "tui"`; use `ctx.hasUI`
  for dialogs supported by TUI/RPC. RPC does not support custom terminal UI.
- Tool exposure and active-tool lists are not permission boundaries. Enforce
  admission on actual calls, including nested calls. Model-only terminal tools
  cannot safely delegate their top-level termination semantics to nested calls.
- An extension hook returning `undefined` ordinarily leaves the host path
  unchanged. Throwing in `before_provider_request` is reported but does not
  block dispatch; compaction cancellation requires `{ cancel: true }`.
- Cancellable lifecycle dispatch stops at an earlier extension's veto.
  Ownership fences cover delivered events and observable state, not every
  attempted navigation. RPC supplies no client-local draft epoch or conditional
  editor write; clients must reject stale consent and preserve newer drafts.
- Session replacement invalidates the old context. Use the fresh destination
  context rather than restoring old editor/session state after an await.
- Load a package from one source only. An installed copy plus a local checkout
  can register duplicate tools, hooks or runtime owners.

## Integration limits

- Subagents uses a checked bridge to private `ModelRegistry.runtime` because the
  public stream helper is not a lossless child-session constructor. Admission
  fails when that bridge is unavailable. Raw parent-context inheritance remains
  disabled; pass explicitly sanitized summaries instead. Acceptance-gate
  memoization keys on Git HEAD/status/diff and disables reuse when untracked
  files exist. It does not establish ignored or external inputs, submodule
  contents, concurrent mutations or command determinism; rerun checks whose
  inputs are outside that snapshot.
- Background jobs are local, session-owned macOS/Linux processes. They are not
  persistent services, PTYs, remote backends or an OS sandbox. Managed children
  exclude this asynchronous process owner.
- Codex opaque checkpoints require the extension and the issuing compatible
  model for full replay. A layered checkpoint (format v2: the previous opaque
  history plus a readable summary of what a failed remote compaction would
  have dropped) cannot be read by `pi-codex-compact` 1.10 or earlier, which
  cancel compaction over it; do not downgrade past a layered checkpoint. Native summary generation cannot decode them. Do not
  treat model switching, disabling the extension or `/compact` as lossless
  migration; retain a private backup and verify a readable recovery summary.
  Canonical-history authorization is not a generic request-filter guarantee.
- Pi supplies no atomic final effective-loadout/checkpoint-publication boundary.
  A later compaction handler can invalidate earlier prompt/tool validation.
  Follow the [Codex package limits](../packages/pi-codex-compact/README.md).
- Analytics event observations are best-effort derived metrics, not a complete
  request log or billing ledger. Cache-warming/reload hooks do not always expose
  physical-request ownership.
- Priority-tier request rewriting does not provide a host pricing bridge. Pi
  prices from the tier the response reports (unchanged through 1.4.0), so
  requested and returned tiers can be accounted differently; do not
  duplicate a pricing catalogue in an extension to conceal that limitation.
- Native external-editor lifetime, cross-extension focus observation and
  concurrent filesystem writers remain host/OS boundaries, not guarantees made
  by an overlay, approval dialog or worktree lock.

## Verification

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run check
```

The root gate checks package configuration, boundaries, shared ranges, test
inventory, versions, Changesets and capability documentation; package lint,
TypeScript and tests; private integration and release/configuration tests;
warning-sensitive packaged-loader smoke; tarball contents; and secret scanning.
Every package also owns an independently runnable `check` script. Keep published
changes covered by a Changeset; versioning and publication follow
[the release guide](releasing.md).

For explicit CLI/PTY acceptance, these checked-in harnesses require macOS/Linux
and Python 3. Run them separately from the root gate:

```sh
python3 packages/pi-background/test/shortcut-cli.py
python3 packages/pi-todo/test/prefill-cli.py "$(mktemp -d)"
python3 packages/pi-sessions/test/ui-cli-cleanup.py
python3 packages/pi-sessions/test/ui-cli.py "$(mktemp -d)"
bun run --cwd packages/pi-subagents build
```

These harnesses exercise their documented fixtures, not every command, third-party
renderer, client or physical terminal. They do not run merely because this guide
lists them.

Offline SDK/faux-provider, process-fixture and rendered-component tests do not
establish live OAuth/provider, browser, external LSP, remote host, physical
terminal/IME or every-platform compatibility. Optional skipped provider tests
are not live acceptance. CLI/PTY harnesses and their limits belong beside their
packages; [status navigation](status-navigation.md) documents its current checks.
A scoped passing test is not a replacement for a failing full root gate.

Source edits do not update a running installation. Installation, activation,
release approval and npm publication are separate operations.

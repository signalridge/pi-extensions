# Compatibility

## Host and dependencies

The development and test target is **Pi 1.5.0**, pinned in development dependencies. A newer host needs its own qualification; an upstream release or one passing test is not a whole-repository compatibility guarantee.

Host-provided `@earendil-works/pi-*`, canonical `typebox` and supported legacy TypeBox modules use literal `"*"` peers. This identifies module ownership, not support for every Pi version. Do not install a second physical host runtime inside an extension. Shared runtime dependency ranges must agree; see [contributing](../CONTRIBUTING.md#shared-dependencies).

Pi 1.5 uses `pi-schema` for tool validation. Rely on supported JSON Schema constraints, not TypeBox-only runtime refinements or codecs. Import TypeBox from its canonical package, not `pi-ai`; process adapters must report `ExecResult.truncated`.

## Integration limits

- Custom terminal components require TUI mode. RPC may support dialogs, but not custom terminal rendering. An installed copy and a checkout copy must not load together.
- Subagents requires a checked bridge to the parent's `ModelRegistry.runtime`; it refuses admission when unavailable. It does not silently construct another runtime or transfer raw parent history. Pass a deliberately sanitized task summary.
- Update Workflows and Subagents together for their shared layout. Execution-protocol compatibility alone does not guarantee mixed-version UI behavior.
- Background jobs are session-owned local macOS/Linux processes, not persistent services, PTYs, remote execution or an OS sandbox. Managed child sessions exclude that asynchronous owner.
- Codex layered checkpoints require format-v2 support. **Do not downgrade to `pi-codex-compact` 1.10 or earlier after such checkpoints exist.** Switching models, disabling the extension or native compaction is not a lossless migration; retain a private backup and a verified readable recovery summary. Follow the [package's replay and authorization limits](../packages/pi-codex-compact/README.md).
- Pi exposes no atomic final effective-loadout/checkpoint-publication boundary. Later hooks can invalidate earlier validation; hook exceptions alone do not necessarily cancel dispatch. Compaction cancellation requires the host's explicit cancellation result.
- Secret projection, analytics and priority-tier accounting have bounded coverage, not universal privacy, request-log or billing guarantees. See [Secrets](../packages/pi-secrets/README.md), [Analytics](../packages/pi-analytics/README.md) and [GPT Fast](../packages/pi-gpt-fast/README.md).
- External-editor lifetimes, physical terminal/IME behavior, concurrent filesystem writers and request-time provider routing remain host/OS/provider boundaries. A cached check does not establish ignored/external inputs or command determinism.

Session, event, permission and persistence rules are summarized in [runtime boundaries](../CONTRIBUTING.md#runtime-boundaries); package references own the detailed contracts.

## Verification

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

The root check includes native schema coercion/rejection and tool-execution tests, compile-time inference, source-session and packaged-loader checks, stable/explicit experimental selections, integration tests and tarball validation. These protect different boundaries; matching schema counts do not make them interchangeable.

Optional CLI/PTY checks require Python 3 and macOS/Linux:

```sh
python3 scripts/workflow-cli.py
# Or select one lane: --lane workflows / --lane notices
python3 packages/pi-background/test/shortcut-cli.py
python3 packages/pi-todo/test/prefill-cli.py "$(mktemp -d)"
python3 packages/pi-sessions/test/ui-cli-cleanup.py
python3 packages/pi-sessions/test/ui-cli.py "$(mktemp -d)"
bun run --cwd packages/pi-subagents build
```

The workflow CLI harness uses the pinned host and isolated faux-only fixtures to check overview placement, resizing, navigation and native package notices. It does not load user resources or dispatch live managed agents. Other harnesses cover their own fixtures, not every client or platform. CLI checks do not run merely because they are listed here.

Offline/faux-provider and component tests are not live OAuth/provider, external-LSP, physical terminal or every-platform acceptance. Keep fresh test inputs and honor each harness's finite cleanup rules. A scoped pass does not replace a failing full gate.

Installing, activating, approving and publishing an extension are separate operations; source edits do not update a running session. See [releasing](releasing.md) for publication.

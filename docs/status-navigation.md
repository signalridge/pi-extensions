# Task and status navigation

These are presentation surfaces, not another execution coordinator:

- `/background` or **Ctrl+Alt+B** opens the shell-job roster. Enter opens the
  selected job's wrapped overview, then Enter or `l` opens its logs. Escape moves
  back through logs, overview and roster. `/background view <id>` opens logs
  directly. Stop/clear still require explicit confirmation.
- **Ctrl+Alt+S** or `/statusline inspect` selects extension statuses. Enter opens
  an opted-in owner's existing UI; unknown statuses show sanitized text instead.
  This does not hide statuses or change settings. The shortcut declines when an
  overlay, autocomplete or an unrecognized focused component owns input; the
  command remains available.
- Workflows owns one complete passive overview **below the editor**, including
  childless runs and observed phases. Fleet does not duplicate workflow-owned
  rows; it remains the standalone-agent surface. `/workflows` keeps the existing
  inspector and exact owned-agent navigation. Expandable workflow groups use
  `▸`, distinct from individual agent status marks. The overview contributes one
  blank separator before the footer, not two.

Background and Workflows publish their own compact footer summaries. Notification
silence does not suppress Background's process-state refresh. Workflow run counts
come from run states, never inferred from completed child calls. Nothing opens a
view automatically on output, completion or status updates.

## Optional status-action wire contract, version 1

Producers and consumers communicate only through `pi.events`. They do not import
another extension's source, infer slash commands from a status key, submit model
messages, or expose execution controls through this channel.

Channels:

- `pi-ui:status-actions:v1:query`
- `pi-ui:status-actions:v1:open`
- Replies: `<channel>:reply:<requestId>`

Query request:

```json
{"version":1,"requestId":"request","sessionId":"session"}
```

Successful discovery reply:

```json
{
  "success":true,
  "data":{
    "version":1,
    "providerId":"pi-background",
    "surfaceId":"opaque-activation-id",
    "sessionId":"session",
    "entries":[{"statusKey":"pi-background","actionId":"tasks","label":"Background tasks"}]
  }
}
```

Open request:

```json
{"version":1,"requestId":"request","providerId":"pi-background","surfaceId":"opaque-activation-id","sessionId":"session","actionId":"tasks"}
```

Successful open reply is `{"success":true,"data":{"accepted":true}}`. This
acknowledges **admission**, not successful rendering or eventual dialog completion.
The producer retains authority over opening and retiring its view. Requests for
another provider, session or surface are ignored, not answered on its behalf.

Records must have exactly their declared own data fields. Accessors, inherited
fields and malformed values confer no action. Identifiers are nonempty strings
of at most 128 characters; status keys and labels allow 512. Discovery bounds
snapshots to 32 providers and 64 total entries. Conflicting snapshots or multiple
owners for one status key are not selectable actions. The consumer discovers on
explicit entry, subscribes before querying, collects for 50 ms, and revalidates
before opening. There is no persistent registration cache or load-order mandate.
Open waits at most two seconds for admission. Cancellation removes listeners and
timers; identifiers remain original data while display copies are sanitized.

A surface belongs to one active TUI session/branch. Producers rotate it on
committed navigation/reload and check live branch ancestry both at admission and
mount. Ordinary appends remain valid; a replaced branch cannot resurrect an old
surface. The consumer fully disposes its selector before handing focus to the
producer. This bus is an optional same-process UI convention, not sender
authentication, an approval grant, process control or a security sandbox.

## Verification boundaries

Focused tests cover the wire validators, delayed replies/mounts, selection
identity, disposal, native selection bindings, bounded logs and paused snapshots.
The private root integration suite loads Background, Subagents, Workflows and
Statusline through the public resource loader in both extension orders and both
TUI renderers. It checks owner UI activation, draft preservation, unchanged
settings and composed Fleet/footer spacing without a model call.

### Native Pi 1.5 workflow overview acceptance

Run from the repository root with the frozen workspace dependencies installed:

```sh
python3 scripts/workflow-cli.py
# Optional isolated lanes; --artifacts must name a NEW directory below /tmp:
python3 scripts/workflow-cli.py --lane workflows --artifacts /tmp/pi15-workflows-acceptance
python3 scripts/workflow-cli.py --lane notices --artifacts /tmp/pi15-notices-acceptance
bun run typecheck:integration
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts scripts/status-navigation.test.ts --maxWorkers 1 --pool forks
bun run check:tests
```

This is checked-in **real CLI/PTY** evidence, separate from the four real-SDK
`status-navigation.test.ts` cases above. It requires Node, Python 3 and macOS/Linux
PTY/process-group support. It refuses a repository CLI other than exactly 1.5.0;
there is deliberately no installed-CLI override in this lane.

The eight workflow cases cover regular/fullscreen, both Workflows/Subagents
factory orders, and Fleet enabled/disabled. A faux root response naturally calls
three real `workflow` tools through normal CLI admission, then finishes. Each
uniquely named childless run reports a phase and awaits an unresolved promise
until its exact owned ID is stopped through a faux root's normal
`workflow_control` calls. No managed agent/model is dispatched. The assertions
check the background-only state, one complete `belowEditor` overview, each run
once across live widgets, no upper/Fleet duplicate, real PTY editor-before-panel
order, and ANSI/Unicode column and row bounds. Real SIGWINCH resizes the overview
and `/workflows` inspector through 120×40, 72×24, 40×16 and 20×8. Short viewports
must summarize hidden runs. Closing the inspector leaves all three running and
starts no model call. Live/settled token figures are not fabricated; this lane
asserts their absence for childless runs. Exact owned-agent conversation
navigation remains SDK/component evidence, not a claim of live-agent acceptance.

The fixture delegates public `setWidget`/`custom` factories and context adapters
to the actual host. It records actual render invocations (including raw ANSI and
SDK-measured widths), placement, public validated UI snapshots and the complete
PTY byte stream. It does not create a second TUI, replace the native editor,
monkeypatch host private fields or call tool definitions directly.

Each workflow case sets a fresh `/tmp` HOME, agent directory, cwd and XDG paths
**before SDK load**. `-ne` plus one explicit fixture loads only Workflows and
Subagents, with skills/prompts/context/themes/MCP disabled. Environment variables
are allowlisted, providers are faux only, startup network checks are disabled,
and an inherited Node preload rejects network access and writes outside the
case sandbox. This guard is a test assertion, not an OS security sandbox.
The notice lane intentionally uses only its own generated local package in a
disposable package settings list, so the native host can establish package
provenance; it does not discover installed user resources.

All waits are finite: 30 seconds for cold CLI/Jiti startup, 12 seconds per
scenario condition, 8 seconds for graceful exit, 2 seconds each for TERM/KILL
cleanup drainage, and a 360-second suite alarm. These are new harness bounds,
not changes to product or existing test deadlines. Each PTY has its own process
group; `finally` owns graceful exit, group escalation on failure, host `waitpid`,
and verification that helper PIDs and the group disappeared. A passing workflow
case requires normal exit and helper reaping **before** safety escalation.
Artifacts are retained in the printed temporary directory: `invocation.json`,
`probe.jsonl`, `processes.jsonl`, `terminal.ansi`, `cleanup.json` and `result.json`.
The default full run currently checks 376 assertions over eight workflow CLI
cases and twelve native notice CLI starts. These optional harnesses do not run
as part of `bun run check`; their TypeScript fixtures do typecheck in the root
integration configuration. See [compatibility](compatibility.md) for the native
notice lane's scope and remaining platform/provider limits.

### Other native CLI evidence

`python3 packages/pi-background/test/shortcut-cli.py` exercises the actual CLI in
regular/fullscreen modes, including native shortcuts, foreign dialogs, draft and
cursor restoration, live resize, real shell logs and confirmed stop. Set
`PI_TEST_CLI` to another installed CLI entrypoint for an explicit host lane.
Widths of one/two cells are component-tested; the complete Pi 1.0.4 editor can
recurse while wrapping a wide draft at one column, so real CLI resize acceptance
uses a minimum of 20 columns. Committed CJK/paste checks are not physical-terminal
IME/preedit qualification. These checks do not establish live-provider/OAuth,
external-LSP or every-platform compatibility.

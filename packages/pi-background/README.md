# pi-background

Opt-in, experimental background shell jobs and low-noise log monitors for the
[Pi coding agent](https://pi.dev). Runs ordinary local processes, not child agents.
There are no model calls while a job is running or a monitor is waiting. Only an
exit or a configured literal log match can request another agent turn.

## Activate

```bash
pi install npm:@signalridge/pi-background
# Or load directly from this checkout:
pi -e ./packages/pi-background
```

This experimental package is opt-in. It registers six model-facing tools without
a new settings schema, global configuration writes by the extension, or changes
to other extensions' configuration. Registration is distinct from exposure: if
Pi's current tool selection hides these tools, the model cannot call them.

For one invocation, add them without replacing the default tool selection:

```bash
pi -e npm:@signalridge/pi-background --tools +bash_background,+monitor,+background_list,+background_logs,+background_stop,+background_clear
```

For persistent activation, merge the package into Pi's existing `packages` and
the tool names into its existing `defaultTools`; do not overwrite either list.
An additive selection for otherwise-default tools is:

```json
{
  "defaultTools": [
    "+bash_background", "+monitor", "+background_list",
    "+background_logs", "+background_stop", "+background_clear"
  ]
}
```

If an explicit plain-name allowlist is already configured, append the six plain
tool names instead. Reload or restart Pi after changing resources/tool selection;
CLI exclusions and permission policies still apply. Guidance encourages model
selection, but does not guarantee that every model chooses background execution.
Older releases such as 1.3.0 provide tools/status, not the interactive task UI
below.

Do not load this package alongside
another extension owning `bash_background`, `monitor`, or `background_*` tools.
The package refuses to start if Pi resolves one of its tool names to an earlier
extension. Pi can disambiguate duplicate commands; load only one background
manager rather than relying on registration order.

The workspace test baseline is Pi **1.0.4**. Real-SDK tests cover delivery,
committed-tree suspended input, and cancelled fork recovery using an offline
faux provider; they are enabled for **1.0.4** and **1.1.0**. Host peers use `"*"`
for module ownership, not a promise of compatibility with every host version.
This version targets local macOS/Linux; baseline acceptance ran on macOS/Pi
1.0.4, not Linux.
Windows, PTY attachment, SSH execution, and durable external services are
deliberately outside this first version. Bun-based and standalone Pi hosts require
a `node` executable on `PATH` for the owned supervisor; missing or stalled startup
fails rather than silently starting an unmanaged command.

## Tools

| Tool | Purpose |
| --- | --- |
| `bash_background` | Start a finite command; return an ID without waiting for completion |
| `monitor` | Start a long-lived command or replace the watch rules of an existing job |
| `background_list` | Inspect running and retained completed jobs, optionally by ID |
| `background_logs` | Read a bounded tail of stdout/stderr, optionally select a stream |
| `background_stop` | Stop an owned process group, wait for exit, retain its logs |
| `background_clear` | Remove completed jobs and their logs; never removes running jobs |

Tools return structured results as well as model-facing text. IDs are opaque and
unique to an extension runtime. There is no tool accepting an arbitrary PID.

The model-facing tool and namespace guidance encourages **proactive**
`bash_background` for long builds, tests, and commands when useful independent
work remains. No separate user request is needed. If a result is an immediate
dependency, use regular `bash` instead. Background tools return opaque job IDs
immediately and notify on completion by default: do independent work rather than
polling or sleeping. Inspect deliberately with `background_list` or
`background_logs`. Ordinary `bash` is never auto-detached or overridden.

### Finite work

```js
bash_background({
  command: "bun run check",
  description: "Repository checks",
  timeout_ms: 1800000,
  notify: "turn"
})
```

The default timeout is 30 minutes, with a maximum of 24 hours. `notify` accepts:

- `turn` (default): an exit requests an agent turn after current work settles;
- `context`: record the event in the transcript without starting a model turn;
- `off`: do not send an exit notification; inspect status and logs explicitly.

A successful start reports a spawned process, not command success. Command
failures appear as a completed job with its exit code/error, and an exit event
unless disabled. Launch validation failures throw a tool error.

### Event-driven monitoring

```js
monitor({
  command: "bun run dev",
  description: "Development server",
  patterns: ["ready", "ERROR"],
  stream: "both"
})

// Or attach rules to an existing job, without starting another process:
monitor({ id: "<job-id>", patterns: ["FAIL", "Tests passed"] })
```

Supply **exactly one** of `command` or `id`. Patterns are case-sensitive literal
substrings of future output lines, not regular expressions. Whitespace is
preserved exactly: `" ERROR "` and `"ERROR"` are different patterns. Only exact
duplicates are removed; bounds apply to the original pattern. Matching happens
incrementally, without requiring a newline. Replacing rules
resets their matching state; previous output is not replayed. Each distinct
pattern fires once by default. Limits are eight patterns, 256 characters per
pattern and 8 KiB per matching line. Oversized lines are truncated for matching;
use logs for their retained content. Stdout and stderr are decoded independently
so fragmented UTF-8 or interleaved streams do not create artificial matches.

Set `repeat: true` for new repeated occurrences and `cooldown_ms` to control their
rate (default 10 seconds, minimum one second, maximum one hour). An old occurrence
is not replayed when unrelated text is appended; matches suppressed during the
cooldown are consumed, not delayed. The extension also
limits automatic wake batches to at most one every ten seconds. Patterns that
never occur remain silent: inspect the actual output to choose accurate markers.

New monitor commands have **no timeout by default**. An optional `timeout_ms`
bounds their lifetime. When attaching to an existing job, its original timeout
and exit-notification policy remain unchanged. `notify` on the watch controls
match notifications (`turn` or `context`); a newly started monitor uses it for
exits too. Attaching cannot change launch cwd/description/timeout.

```js
background_logs({ id: "<job-id>", tail: 200, stream: "stderr" })
background_stop({ id: "<job-id>" })
background_clear({ id: "<completed-job-id>" })
```

## Interactive task UI

Only explicit human commands or **Ctrl+Alt+B** open a screen; job output and model
tool calls never steal focus. Press **Ctrl+Alt+B** from Pi's native prompt editor
to choose a task (including an empty list when no jobs exist). While jobs or
notifications are retained, the owned status line shows `Ctrl+Alt+B tasks` beside
compact counts: `R` running, `F` finished, `P` pending notifications, and
`PAUSED` when notification delivery needs attention. The pending/paused markers
remain readable in a 40-column status allocation. This is a keyboard entry hint,
not a clickable status-bar button: Pi's `setStatus` API accepts text only. The shortcut uses Pi's
editor shortcut route, not a raw terminal listener; focused dialogs and viewers
retain their input and a repeated shortcut does not reset selection. Custom
editors must forward Pi's extension shortcuts to support it. **Ctrl+B** is unchanged.
Escape returns to the original editor draft and cursor.

Commands remain available:

```text
/background                 # live task list
/background view <job-id>   # live stdout/stderr log viewer
/background status         # notification/status snapshot, no custom screen
/background retry          # existing explicit notification recovery
```

Task selection follows the opaque ID as jobs change. The selected task shows its
command, cwd, status, exit code/signal, and dropped log bytes. The log viewer has
scrolling, follow-tail, and both/stdout/stderr filters. Keyboard controls:

- **↑/↓**, **Home/End**, **PgUp/PgDn**: select tasks or scroll logs; End follows the log tail.
- **Enter**: open selected logs; **Esc**: return to tasks, then close.
- **f**: toggle tail following; **s**: cycle both/stdout/stderr.
  Pausing keeps one bounded, sanitized snapshot stable while output continues;
  End or resuming follow refreshes the current retained tail. Resize preserves
  the snapshot's source position. A one-column terminal marks oversized
  graphemes as `?`; widening restores their original text.
- **x**, then **y**: stop exactly the captured owned job and wait for confirmed exit.
- **d**, then **y**: clear exactly one confirmed terminal job, never a running job.
  Any other key cancels confirmation; repeated keys and Enter do not confirm.

Stop/clear use the same manager and cancellation ownership as tools, including
cancelling only undelivered notices. Stop failures remain visible and recoverable
without changing selection. Session retirement closes the old screen and releases
its subscriptions before late output or async results can draw or control jobs.
Cancelled navigation preflight does not retire jobs.

Layout fits the current terminal height in regular and fullscreen modes, including
narrow/CJK terminals. Untrusted logs are byte-bounded **before** sanitization and
wrapping, without Markdown interpretation or terminal control sequences. The
viewer shows at most the latest 1,000 retained lines and 64 KiB before wrapping;
manager retention stays at 256 KiB per job. Closing a view releases its local
subscriptions; output changes request coalesced TUI renders, not model turns.

Custom screens require both `ctx.mode === "tui"` and `ctx.hasUI`. RPC/JSON/print
keep all tools and command snapshots/hints, but never call custom UI. The TUI
module is host-provided and deferred until an explicit TUI command or shortcut. There is no
PTY attachment, raw-PID control, SSH support, or durable job scope.

## Lifecycle and limits

- At most eight running jobs and 32 retained jobs. Admission evicts the oldest
  completed job when necessary, never a running process.
- Combined stdout/stderr retention is 256 KiB **per job**, in memory. Oldest bytes
  are discarded; `droppedBytes` exposes this loss. Logs default to 200 lines and
  accept at most 1,000; model-facing log text is additionally capped at 24 KiB.
- Pending notifications are bounded and coalesced per job. Event messages are
  capped at 8 KiB; whole job summaries that do not fit remain queued for a later
  batch. Individual excerpts are truncated. Capacity overflow warns and is counted
  in the next accepted event message. Output is explicitly marked untrusted data.
  Terminal control sequences are removed from model-facing output.
- Jobs survive ordinary agent turns. Reload, successful session replacement,
  session-tree navigation, and shutdown terminate jobs and discard their logs
  and undelivered notifications. **No jobs or logs are restored from a session
  file**, and no temporary log files are written.
- Stop and shutdown send TERM, then escalate to KILL while the original owned
  process-group leader is still live. Stop waits for confirmed exit. Normal shell
  completion reports its result on shell exit, not pipe closure, and cleans
  same-group descendants with inherited or redirected output. Pipes keep draining
  through cleanup, preserving the shell's exit result and termination logs.
  Cleanup grace is not charged to the command deadline. Intentional-stop output remains
  in logs but cannot create new watch notifications. Commands must not daemonize
  or escape their process group; this is not a service manager.
- The supervisor's startup handshake is bounded to five seconds independently
  of the command timeout, including inherited Node debugger flags.
- Cancelling the launch before successful startup cleans up the process. Once
  the tool returns, the job belongs to the session, not to that tool's abort
  signal. Use `background_stop` to cancel later.
- No polling model turns, sleep loops, or background agents. Small timers only
  implement timeout, termination grace, batching and notification cooldown.

### Notification safety and recovery

Events remain extension-local while Pi is busy, compacting, navigating sessions,
or has queued work. Delivery is guarded by the fully settled boundary rather than
`agent_end`. No background message is inserted between a tool call and its result.
Events are persisted as context-only custom messages; a separate short user-message
wake runs the normal `input`/`before_agent_start` prompt pipeline. This preserves
other extensions' guidance, routing and continuation hooks. An exact wake ID
acknowledges the resulting user message before provider execution. The input hook
also consumes a known extension-sourced wake whose job owner has retired,
including a wake suspended in an earlier input handler when the host commits a
new leaf before this package's tree callback runs. Ownership captures the session
manager, session ID, and observed branch entry-ID prefix. Ordinary appends remain
owned; divergence retires the owner permanently at tool, delivery, consumption,
ACK, and asynchronous UI/update boundaries. Unrecognized lookalike inputs are
left unchanged. Context-only acceptance is
confirmed directly in the public transcript without a model call.
Terminal events are not duplicated by multiple child-process callbacks.

Synchronous delivery errors or an unaccepted wake observed at a settled boundary
are retried at most three times with backoff, then delivery pauses. A missing
acknowledgment after a run starts, or after a 30-second acknowledgment deadline
without a settled event, is ambiguous: delivery pauses instead of blindly
resending. This also exposes consumed input and asynchronous host rejection;
a late exact acknowledgment clears the pause.
`background_list` reports pending/paused delivery and the TUI shows a compact
owned status line. Use:

```text
/background status
/background retry
```

Retry is an explicit recovery action and can redeliver an ambiguously acknowledged
message. An input consumed by another extension, cancelled navigation, or manual
compaction without a subsequent agent run can defer notices; use retry after Pi
is idle. Switch, tree, and fork preflight gate delivery without destroying jobs or
the outbox on cancellation. Retry rechecks its captured live owner after waiting
for idle; it cannot recover an owner retired by committed navigation. Already handed-off transcript messages cannot be retracted by stopping a
job. Public hooks cannot fence an arbitrary later extension handler that suspends
after this package's input guard. Intentional stops/clears cancel only undelivered
notices.

`context` notifications do not start a model turn but become part of later model
context. `turn` notifications can consume provider tokens. Repeated monitoring is
an explicit opt-in, not a guarantee of zero cost.

TUI status is guarded by `ctx.mode === "tui"`; supported notifications use
`ctx.hasUI`. Tools work independently of UI in RPC/JSON/print modes, but a
short-lived host may shut down before a background job finishes and then kills
it. Use an interactive or long-lived RPC session for asynchronous work.

## Security and integration

Commands run with Pi's full local operating-system permissions using
`/bin/bash -c`. This package does not replace builtin `bash`, inherit its shell
path/prefix override, or detect another extension's remote workspace. Do not use
it for remote commands or to bypass a rejected foreground command.

Tools publish read-only/destructive/open-world annotations for permission
extensions. **Annotations are hints, not a sandbox.** An approval policy that
handles only `bash` must explicitly cover `bash_background` and `monitor` too.
Plan-mode users must not opt these mutating tools into a read-only loadout.
There is no automatic change to any other extension's tool selection or settings.

### Optional operation approvals

`@signalridge/pi-approval-core` is a runtime dependency, but no approval extension is enabled automatically. When a human approval service is present at invocation entry, `bash_background` and command-starting `monitor` capture exactly that service before any await and review frozen normalized launch inputs. Denial, cancellation or stale ownership prevents command execution. The invocation-local launch guard checks the live branch owner and **the same captured service** after filesystem startup validation and immediately before sending the supervisor its run command. Service disappearance, replacement, malformed or ambiguous discovery retires that capture and fails closed: no switching peers, second approval prompt or ungated fallback. A supervisor already awaiting dispatch is cleaned up without executing the command. Absence at invocation entry alone preserves ordinary ungated behavior. Existing-job monitor attachment and inspection/control tools do not request launch approval. This cooperative same-process integration is not an OS sandbox.

This package does not resume or mutate a paused `pi-goal`. A background event can
start a normal agent turn; that is distinct from granting Goal ownership or
resuming an explicit Goal wait. No undocumented cross-extension protocol is used.

Logs can contain secrets. Retained raw logs stay in memory, but inspected output
and delivered events become part of Pi's transcript; avoid monitoring sensitive
streams.

For jobs that must survive closing Pi, use a terminal multiplexer or an external
service manager with an explicit ownership and reconnection policy.

## Design references

This is an independent implementation, not a bundled fork. References:

- [99percentpeople background tasks](https://github.com/99percentpeople/pi-extensions/tree/master/extensions/background-tasks): explicit process ownership and separate inspection/control operations;
- [aliou/pi-processes](https://github.com/aliou/pi-processes): event-driven attention levels and log watches; adversarial DCS/C1/fragmented terminal-control fixture forms inform plain-text sanitization tests (not its rendering implementation);
- [fl4p background shell](https://github.com/fl4p/pi-extensions/blob/master/extensions/bash-background.ts): finite exit notifications and coalesced output;
- [Pi extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): public tools, lifecycle and custom messages.

PTY, SSH, shell-provider protocols and cross-application persistence are not copied
into this package. The runtime library dependency is `@signalridge/pi-approval-core`;
Pi modules remain host-provided, and process supervision uses Node builtins.

## Development

```bash
bun run --cwd packages/pi-background check
# Actual CLI shortcut/focus acceptance (macOS/Linux, Python 3 standard library):
python3 packages/pi-background/test/shortcut-cli.py
```

Historical task-viewer acceptance reported 108 passing package tests and the
complete repository gate. Historical Pi 1.0.4 CLI runs through isolated
fullscreen/regular PTYs reported 161 checks, covering model tool exposure, asynchronous real shell
execution alongside independent work, live logs, paging, CJK resize, distinct-key
stop/clear, editor draft restoration and process-group cleanup. Fixtures use an
offline faux provider and harmless local processes, not live provider credentials
or physical-terminal qualification. The committed `test/shortcut-cli.py` harness separately recorded 72 shortcut checks
across 100×30 and 40×12 fullscreen/regular CLI PTYs: empty entry, repeated keys,
CJK draft/cursor restoration, native dialog/foreign overlay focus, stable task
selection, log/stop navigation without model turns, and committed session
retirement. Its instrumentation observes public component renders and editor text;
Pi still owns actual terminal input, global shortcut routing, focus, and rendering.
Historical counts are reports from those runs, not evidence that uncommitted
CLI instrumentation can be rerun from this package. Use committed tests and the
explicitly named shortcut harness for reproducible checks.

## License

MIT

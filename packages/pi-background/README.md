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

The workspace test baseline is Pi **1.4.0**. Real-SDK tests cover delivery,
committed-tree suspended input, and cancelled fork recovery using an offline
faux provider on that host. Host peers use `"*"` for module ownership, not a
promise of compatibility with every host version. This version targets local
macOS/Linux; baseline acceptance ran on macOS/Pi 1.4.0, not Linux.
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

## Finite work

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

## Event-driven monitoring

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


Supply exactly one of command or id. Patterns are case-sensitive future-output literal substrings, not regexes; no newline is required and prior output is not replayed. Each pattern fires once by default; repeat: true opts into repeated occurrences with cooldown_ms (default 10s, range 1s–1h). Limits: eight patterns, 256 characters each, 8 KiB matching lines. New monitor commands have no timeout unless timeout_ms is set; attaching preserves original launch/exit policy. [Matching and delivery reference](docs/reference.md#event-driven-monitoring).

## Interactive task UI

Only human `/background` or Ctrl+Alt+B opens the task roster; Enter → overview → logs (or l), Esc backs out preserving draft/cursor. `/background view <id>` opens logs; `status` reports delivery state and `retry` explicitly recovers paused notices. Stop x then y and clear d then y require distinct confirmation. Ctrl+B is unchanged. Ctrl+Alt+S → Background tasks also opens the owner view when supported. Tools/output never steal focus. RPC/JSON/print keep tools/snapshots, not custom UI; short-lived hosts may kill unfinished jobs. [Complete controls, viewport and ownership](docs/reference.md#interactive-task-ui).

## Lifecycle and limits

At most eight running/32 retained jobs, with 256 KiB combined logs per job; oldest completed jobs/bytes may be evicted. Logs default to 200 lines (max 1,000), model text 24 KiB. IDs are session-owned, never arbitrary PIDs. Jobs survive ordinary turns, not reload/session/tree replacement/shutdown: no durable jobs/log restoration or temporary log files.

Exit notifications default to turn and can cost provider tokens; context records without a turn, off is silent. Reading a terminal job with logs or an explicit-ID list consumes its exit reminder, not unread monitor matches; all-jobs/running/cancelled reads do not. Already accepted messages cannot be retracted. Delivery pauses on missing/ambiguous ACK or after three bounded retries; explicit retry can duplicate an ambiguously acknowledged message. Overflow records context without waking: compact or start a new session. [ACK, retries and recovery](docs/reference.md#notification-safety-and-recovery).

Stop waits for confirmed owned group exit. TERM/KILL cleanup is not a service manager: commands must not daemonize or escape their group. Node supervisor readiness is bounded to five seconds, independently of job timeout.

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
into this package. It has no runtime dependencies: Pi modules remain host-provided,
and process supervision uses Node builtins.

## Development

```bash
bun run --cwd packages/pi-background check
python3 packages/pi-background/test/shortcut-cli.py
```

[Bounded historical acceptance](docs/reference.md#development) distinguishes offline macOS/PTY evidence from Linux, live-provider and physical-terminal qualification.

## License

MIT

## Reference

Detailed contracts and legacy section links:

- <a id="notification-safety-and-recovery"></a>[Notification safety and recovery](docs/reference.md#notification-safety-and-recovery)
- <a id="status-navigation"></a>[Status navigation](docs/reference.md#status-navigation)

# pi-goal — goal mode for the Pi coding agent

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-goal` is a native [Pi coding agent](https://pi.dev) extension that adds session-scoped `/goal` commands, a `goal_complete({ goal_id, summary })` completion tool, and a strict `goal_blocked({ goal_id, reason, evidence, repeated_turns })` impasse tool for autonomous, verifiable task completion. A stable, opt-in ordered queue extends the same command and tool namespace. Queue execution remains off by default.

<a id="features"></a>

Goal mode uses Codex-like persistence instructions and sends guarded continuation messages from Pi's fully settled idle boundary until the agent completes the goal, the user pauses or clears it, a safety circuit breaker trips, a true blocker or provider usage limit stops it, or an optional token budget is reached. With ordered goals enabled, the same lifecycle advances through queued objectives one at a time.

## Install

The current tested host is Pi `1.4.0`. Host-provided dependencies use `"*"` peers to identify module ownership, not to guarantee compatibility with every Pi version. See the [compatibility guide](https://github.com/signalridge/pi-extensions/blob/main/docs/compatibility.md) for verification details. The `agent_settled` lifecycle event this extension depends on landed in `0.80.6`.

```bash
pi install npm:@signalridge/pi-goal
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-goal
```

<a id="use-cases"></a>

## Quick start

```text
/goal --tokens 100k fix the failing test and verify it
/goal status
/goal pause
/goal resume
```

Bare `/goal` opens a state-aware TUI manager; RPC reports status. Print/JSON status commands reject observably. A reached automatic-work limit offers Review and continue without losing objective, usage, active time or queue.

## Commands

| Command | Action |
| --- | --- |
| `/goal <objective>` / `--tokens <budget>` | Start or confirm replacement; budgets accept 100k, 1.5m |
| `/goal status` | Current state and accounting |
| `/goal edit [--tokens <budget>] <objective>` | Preserve usage; an exhausted budget reactivates only if raised above usage |
| `/goal pause` / `resume` | Stop / explicitly restart with a fresh guard ID and safety epoch |
| `/goal clear` | Remove current goal/queue and pending intent, not unrelated work |
| `/goal add` / `prioritize` | Queue append / urgent head, each accepting --tokens |
| `/goal drop-last` / `skip` | Remove tail / head; activate successors only when settled |

Objectives are limited to 4,000 characters; reference a file for longer instructions. Queue commands require opt-in; hidden aliases are push/unshift/pop/shift. Disabled queue words stay ordinary objective text (`/goal add docs` starts “add docs”). Direct destructive routes remain immediate for compatibility; menu actions preview and confirm. [Full commands, failure rollback and manager controls](docs/reference.md#commands).

## Configuration

Optional global `~/.pi/agent/pi-goal.json`; absent files are not created until an explicit Settings save.

| Key | Default | Meaning |
| --- | --- | --- |
| `toolVisibility` | `after-first-goal` | Hide terminal tools until activation/unfinished restore; `always` keeps the baseline schema |
| `experimental.goals` | `false` | Stable ordered queue, OFF until explicitly enabled |
| `experimental.notices` | `true` | Once-per-session queue announcement only; failures still warn |
| `rpc.enabled` | `false` | Trusted sibling cooperation, not authentication/sandboxing |
| `continuationLimits.automaticTurns` | `25` | Positive safe integer; explicit null means Unlimited |
| `continuationLimits.noProgressTurns` | `3` | Positive safe integer; null disables the repeat heuristic |

The legacy `experimental` namespace and both booleans remain fully supported, not deprecated or migrated. Menu writes apply immediately; external edits need reload. Invalid files remain untouched and Settings becomes read-only. Unlimited mode requires confirmation and can consume uncapped provider cost. [Complete validation, visibility and persistence rules](docs/reference.md#configuration).

## Ordered queue stability and compatibility

The queue contract is stable but remains opt-in and OFF by default. Commands, legacy readers, canonical-clear precedence, settled activation, freeze/re-enable, IDs and per-item accounting remain supported. [All five readiness criteria, pinned source/test/version evidence and bounded host qualifications](docs/reference.md#ordered-queue-stability-and-compatibility).

## Completion, waiting and recovery

- Goal-owned continuation waits for fully settled idle, after retries, compaction and queued input. A 25-response automatic epoch or three empty/normalized-identical tool-free runs pauses by default; an ordinary notification does not reset/resume a safety pause.
- `goal_complete({ goal_id, summary })` needs the exact current ID and requirement-by-requirement evidence. Plain prose is not completion; prompts are guardrails, not independent verification of external work.
- `goal_blocked({ goal_id, reason, evidence, repeated_turns })` needs concrete external-action evidence and the same blocker for at least three consecutive goal turns; resume starts a fresh audit. Not for ordinary clarification or recoverable failures.
- `goal_wait({ goal_id, reason, resume_after_ms? })` is only for an external wait. It pauses until accepted real input or the deadline; under 10 seconds is clamped. Call all terminal tools directly and alone, never through scripts or nested `ctx.executeTool()` calls; direct model declarations remain available with codemode `on` or `only`. [Why direct calls are required](docs/reference.md#how-completion-works).
- Tools missing under restrictive policy pause Goal rather than widening policy. Token budgets can overshoot by a model call and are not dollar caps. Context overflow blocks automatic continuation: compact or start a new session, then explicitly resume.
- State is branch/session-owned and survives compaction/reload; new sessions do not inherit it. Disabled retained queues freeze without losing items. [Lifecycle, waits, accounting and interruption](docs/reference.md#session-and-reload-behavior).

## Managed run RPC

Default-off `rpc.enabled` exposes `pi-goal:start`, `pi-goal:cancel` and `pi-goal:event:${runId}` for fully privileged trusted extensions. Only complete is success; cancellation is exact-run scoped, and manual/restored Goals are not adopted. Removed `pi-goal:rpc:start`/`pi-goal:rpc:pause` and global `pi-goal:state` have no aliases. [Complete payloads, errors and ownership](docs/reference.md#managed-run-rpc).

<a id="package-layout"></a>

`src/index.ts` is the extension entrypoint, forwarding to `goal.ts`; other modules are internal.

## License

MIT. See [`LICENSE`](./LICENSE).

## Reference

Detailed contracts and legacy section links:

- <a id="session-and-reload-behavior"></a>[Session and reload behavior](docs/reference.md#session-and-reload-behavior)
- <a id="statusline-states"></a>[Statusline states](docs/reference.md#statusline-states)
- <a id="token-budgets-and-elapsed-time"></a>[Token budgets and elapsed time](docs/reference.md#token-budgets-and-elapsed-time)
- <a id="how-completion-works"></a>[How completion works](docs/reference.md#how-completion-works)
- <a id="blocked-goals"></a>[Blocked goals](docs/reference.md#blocked-goals)
- <a id="interruption-and-queued-input-behavior"></a>[Interruption and queued-input behavior](docs/reference.md#interruption-and-queued-input-behavior)

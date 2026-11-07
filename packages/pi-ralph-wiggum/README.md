# Ralph Wiggum Extension

Flat, in-session agent loops for verifiable iterative development, adapted from Geoffrey Huntley's Ralph loop. Ask Pi to create and run a task checklist, optionally with periodic reflection. Multiple loops can coexist in one repository; a separate Pi via tmux remains an alternative.

<img width="432" height="357" alt="Screenshot 2026-01-07 at 17 16 24" src="https://github.com/user-attachments/assets/68cdab11-76c6-4aed-9ea1-558cbb267ea6" />

**Note: This is a flat version without subagents, similar to the [Anthropic plugins implementation](https://github.com/anthropics/claude-code-plugins/tree/main/ralph-loop).**

## Install

```bash
pi install npm:@signalridge/pi-ralph-wiggum
```

The package manifest already selects its extension and `SKILL.md`; no additional resource filter is required.

## Recommended usage: just ask Pi
You ask Pi to set up a ralph-wiggum loop.
- Pi sets up `.ralph/<name>.md` with goals and a checklist (like a list of features to build, errors to check, or files to refactor)
- You let Pi know:
  1. What the task is and completion / tests to run
  2. How many items to process per iteration
  3. How often to commit
  4. (optionally) After how many items it should take a step back and self-reflect
- Pi runs `ralph_start`, beginning iteration 1.
  - It gets a prompt telling it to work on the task, update the task file, and call ralph_done when it finishes that iteration
  - When the iteration is done, it calls `ralph_done`, resending the same prompt*
- Pi runs until either:
  - All tasks are done and final verification is externally rerunnable (Pi sends `<promise>COMPLETE</promise>`)
  - Max iterations (default 50)
  - You hit `esc` (pausing the loop)
If you hit `esc`, you can run `/ralph-stop` to clear the loop. Use `/ralph resume <name>` to explicitly resume a paused or unbound loop.

## Iterations, sessions and context windows

An iteration is a new agent turn in the same Pi session, not a fresh context window. `ralph_done` queues the next prompt and the task file carries durable progress, while Pi's normal compaction can summarise older conversation when the context grows. This extension deliberately uses that flat, in-session design; it does not launch a new Pi process or session for each iteration.

Each active loop is owned by its live Pi session and branch prefix. Ordinary appends retain ownership; committed tree navigation or live branch divergence retires automatic delivery without changing another branch's loop state. Reload restores a loop only when its recorded branch proves ownership. Older state without that proof, a different session, or a navigated branch requires `/ralph resume <name>`.

Each iteration delivery has a private, one-use identity, consumed at accepted native binding rather than at a later context hook. Loop instructions are request-local hidden context, not edits to real user text or images. Accepted user continuations can work on the current loop; unrelated extension wakes cannot advance or complete it. Distinct queued text/images do not erase a uniquely attributed continuation, regardless of steer/follow-up ordering. Identical-content collisions across sources or lanes fail closed; unobserved or transformed content cannot acquire ownership.

Pending provenance expires after five minutes and is bounded to 256 candidates and 128 deliveries. Authenticated runtime nonces still recognize stale deliveries after eviction or retirement without retaining old task bodies or an unbounded replay list. An expired queued iteration needs an explicit `/ralph resume <name>`. Pause, cancel, and confirmed nuke synchronously retire ownership before deleting state. An active authenticated iteration also aborts immediately through its public operation context, so a later awaited tool-call handler cannot let a previously permitted substantive tool execute. The abort is pinned to the accepted nonce, live manager/session/branch, and original signal; it never transfers to a new root, ordinary manual user turn, or unrelated background wake. User continuations may advance loop progress without transferring ownership of their operation. Late tools from retired extension iterations remain blocked until settlement.

State publication uses private temporary files and atomic rename. Malformed state warns by filename, remains unchanged, and does not prevent other valid loops from loading. Start and resume refuse to replace a still-running authenticated iteration; stop it or wait for settlement first, preserving its cancellation authority. Task content must be readable and non-whitespace before activation changes ownership or state. Authorized activation pauses duplicate active loops only when the same session and branch prove ownership; foreign and sibling-branch loops remain untouched.

Completion and iteration-limit outcomes are finalized at `agent_settled`, after retries and any pre-settlement continuation. Terminal banners are non-triggering custom messages, not extra user turns; they remain visible to future model context.

## Completion gate

For build/test/refactor tasks, Ralph prompts the agent not to complete based only on checked checklist items. Before sending `<promise>COMPLETE</promise>`, the agent should:

- Preserve any build artifacts, generated files, virtualenvs, or copied libraries required by final verification.
- Record the exact final command, working directory, relevant environment variables, and output summary in the task file.
- Ensure a separate monitor can rerun that command from the same worktree in a fresh shell.
- Mark work blocked or deferred if the final command cannot be made externally rerunnable.

## Stale prompt guard

Known paused, completed, replayed, or retired iteration deliveries are rejected before provider work; native-context and tool boundaries also recheck live ownership. Unknown marker-shaped user literals remain ordinary text. Completion requires a positively owned iteration and an exact standalone `<promise>COMPLETE</promise>` line outside quotes and fenced code; quoting or discussing the marker does not complete a loop.

## Commands

| Command | Description |
|---------|-------------|
| `/ralph start <name\|path>` | Start a new loop |
| `/ralph resume <name>` | Resume a paused loop |
| `/ralph stop` | Pause current loop |
| `/ralph-stop` | Stop active loop (idle only) |
| `/ralph status` | Show all loops |
| `/ralph list --archived` | Show archived loops |
| `/ralph archive <name>` | Move loop to archive |
| `/ralph clean [--all]` | Clean completed loops |
| `/ralph cancel <name>` | Delete a loop |
| `/ralph nuke [--yes]` | Delete all .ralph data |

### Options for start

| Option | Description |
|--------|-------------|
| `--max-iterations N` | Stop after N iterations (default 50) |
| `--items-per-iteration N` | Suggest N items per turn (prompt hint; default 0, no limit) |
| `--reflect-every N` | Reflect every N iterations (default 0, disabled) |

Counts must be nonnegative safe integers, validated before task files or ownership change.
CLI values use decimal integer digits (optionally quoted), not fractions or exponent notation.
`0` preserves the existing no-limit/disabled behavior; omitted values keep their defaults.

## Agent tool

The agent can self-start loops using `ralph_start`:

```
ralph_start({
  name: "refactor-auth",
  taskContent: "# Task\n\n## Checklist\n- [ ] Item 1",
  maxIterations: 50,
  itemsPerIteration: 3,
  reflectEvery: 10
})
```

## Credits

Based on Geoffrey Huntley's Ralph Wiggum approach for long-running agent tasks and Thomas Mustier's [Pi extension](https://github.com/tmustier/pi-extensions/tree/f2632e7da3cadc4f22fb8367e7c4454779ec1a05/pi-ralph-wiggum). Local adaptations retain exact-content HMAC admission, session/branch ownership, and operation-scoped cancellation rather than permissive marker matching.

## Changelog

See `CHANGELOG.md`.

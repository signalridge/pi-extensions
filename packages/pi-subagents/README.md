# @signalridge/pi-subagents

Signalridge's managed subagent package for Pi, including protocol-v3 spawning, lifecycle isolation, Fleet UI, persistence, and recovery.

A [pi](https://pi.dev) extension that brings **Claude Code-style autonomous sub-agents** to pi. Spawn specialized agents that run in isolated sessions — each with its own tools, system prompt, model, and thinking level. Run them in foreground or background, steer them mid-run, resume completed sessions, and define your own custom agent types.


## Features

- **Claude Code look & feel** — same tool names, calling conventions, and UI patterns (`Agent`, `get_subagent_result`, `steer_subagent`) — feels native
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 4) and smart group join (consolidated notifications)
- **Live FleetView UI** — one navigable list below the editor with a status mark per row, live tool activity, token counts, and text status labels. Enter opens the selected agent's conversation. Toggle via `/agents → Settings → Fleet view`
- **FleetView** — Claude Code-style navigable list of `main` + every running subagent rendered below the editor (earliest-launched first). Press `↓` (or `←`) at an empty prompt to jump in, `↑`/`↓` to move the selection, `Enter` to open the selected agent's live, auto-updating conversation, `Esc` to return. Finished agents linger briefly before dropping out, and a viewer stays open through completion so you can read the final output. Toggle via `/agents → Settings → Fleet view`
- **Conversation viewer** — select any retained agent with a session in `/agents` to open a live-scrolling, four-sided bordered overlay of its full conversation (auto-follows new content, scroll up to pause). Press `Enter` to chat: type a message, then `Enter` to send (`Esc` or an empty submit returns); it appears as a user message and redirects the agent after its current tool. Press `x` (then `x` again to confirm) to stop a running agent — this works for background agents too
- **Custom agent types** — define agents in `.pi/agents/<name>.md` or `.agents/agents/<name>.md` (project) or globally, with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions
- **Nested subagents** — opt-in, default-off delegation: a custom agent that sets `allowed_subagents` gets its own ownership-scoped `Agent`, `get_subagent_result`, and `steer_subagent` tools, depth-capped from the main session (default 2). It can control only its own children, they are stopped when it finishes, and their transcripts and token spend roll up to it. The allowlist is a privilege boundary — a child runs with its own tools, so pick it as carefully as `tools:` itself
- **Mid-run chat** — inject messages into running or queued agents to redirect their work without restarting. From the main prompt, use `@handle message` (with `@` autocomplete); configure this under `/agents → Settings → Agent mentions`.
- **Session resume** — pick up where an agent left off, preserving full conversation context
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort, producing clean partial results instead of cut-off output
- **Case-insensitive agent types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work. Unknown types fall back to general-purpose with a note
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed
- **Persistent agent memory** — three scopes (project, local, user) with automatic read-only fallback for agents without write tools
- **Git worktree isolation** — run agents in isolated repo copies; changes auto-committed to branches on completion, with an explicit prompt guard keeping the base checkout off-limits
- **Skill preloading** — inject named skills into agent system prompts, discovered from `.pi/skills/`, `.agents/skills/`, and global locations (Pi-standard `<name>/SKILL.md` directory layout supported)
- **Tool denylist** — block specific tools via `disallowed_tools` frontmatter
- **Styled completion notifications** — background agent results render as themed, compact notification boxes (icon, stats, result preview) instead of raw XML. Expandable to show full output. Group completions render each agent individually
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity
- **Cross-extension RPC** — other Pi extensions can spawn and stop subagents via the `pi.events` event bus (`subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop`). Protocol v4 adds managed spawning, a request-level Agent `tier`, toolset/denylist/thread/worktree hints, owner-scoped stop/quiescence, a published Agent-tier routing policy, and standardized reply envelopes; pi-subagents remains the final policy owner. Pre-schema-v2 managed tombstones are quarantined rather than replayed. Emits `subagents:ready` on session start
- **Schedule subagents** — pass `schedule` to the `Agent` tool to fire on cron / interval / one-shot. Session-scoped jobs with PID-locked persistence; results land via the same `subagent-notification` followUp path as manual background completions; manage via `/agents → Scheduled jobs`
- **Model tiers** — name a (model, thinking) pair once and let the orchestrator pick it by name; the `Agent` tool exposes `tier` and never `model`/`thinking`, so which model runs stays a config decision. Manage the catalogue in `/agents → Model tiers`, pick the default in `/agents → Settings → Default tier`, or set a plain `defaultModel` when one line beats a catalogue
- **Model scope enforcement** — opt-in validation that subagent model choices stay within your pi `enabledModels` allowlist (sourced from `/scoped-models`, with both global and project-local pi settings honored). Caller-supplied out-of-scope → hard error to orchestrator; frontmatter-pinned out-of-scope → warning + runs anyway (frontmatter authoritative). Toggle via `/agents → Settings → Scope models`
- **Resilient agent files** — malformed custom `.md` files are skipped with a path-qualified warning so one bad file cannot prevent startup; enable `/agents → Settings → Strict agent files` when startup should fail closed instead

## Install

```bash
pi install npm:@signalridge/pi-subagents
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-subagents
```

## Lint policy

Formatter checks remain disabled for this package, while legacy `noExplicitAny`, control-character regex, and empty-interface rules remain off. Signalridge additions follow the package AGENTS rules and the strict `--error-on-warnings` lint gate.

## Quick Start

The parent agent spawns sub-agents using the `Agent` tool:

```
Agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Foreground agents block until complete and return results inline. Background agents return an ID immediately and notify you on completion.

### Scheduling

Add a `schedule` field to register the agent to fire later instead of running now:

```
Agent({
  subagent_type: "Explore",
  prompt: "Look at recent commits and summarize what changed since last week",
  description: "Weekly commit review",
  schedule: "0 0 9 * * 1",   // 9am every Monday (6-field cron)
})
```

Schedule formats:

- **Cron** — 6-field (`second minute hour day-of-month month day-of-week`), e.g. `"0 0 9 * * 1"` for 9am every Monday, `"0 */15 * * * *"` for every 15 minutes.
- **Interval** — `"5m"`, `"1h"`, `"30s"`, `"2d"`. Fires repeatedly at that interval.
- **One-shot relative** — `"+10m"`, `"+2h"`, `"+1d"`. Fires once at that future time.
- **One-shot absolute** — full ISO timestamp, e.g. `"2026-12-25T09:00:00.000Z"`.

When a schedule fires, the spawn runs in background and its completion notification arrives in the conversation through the same `subagent-notification` followUp path as a manually-spawned background agent — your parent agent reasons about the result the same way. The fire also draws itself into the FleetView list, so a scheduled run is visible while it works and not only when it reports.

Schedules are **session-scoped**: they reset on `/new` and restore on `/resume`. List and cancel via `/agents → Scheduled jobs` (creation is the `Agent` tool's job — there is no parallel manual-create wizard). Storage at `<cwd>/.pi/subagent-schedules/<sessionId>.json` with PID-based file locking for cross-instance safety.

**Disable the feature entirely**: `/agents → Settings → Scheduling → disabled` removes `schedule` from the `Agent` tool spec (no LLM-context cost), hides the menu entry, and stops any active scheduler. The schema-level removal takes effect on the next pi session; the runtime kill is immediate. Re-enable from the same menu.

Restrictions:
- `schedule` cannot be combined with `inherit_context` (no parent conversation exists at fire time) or `resume` (schedules create fresh agents).
- Scheduled agents always run in the background; explicitly setting `run_in_background: false` is rejected rather than silently changed.
- Scheduled fires bypass the `maxConcurrent` queue so a 5-minute interval cannot be deferred behind long-running manual agents.
- **Headless `pi -p` doesn't wait for scheduled subagents.**

## UI

Running agents are drawn in exactly one place: the FleetView list below the
editor (see below). Earlier versions also rendered a widget above the editor and
repeated the same summary in the footer status; a single surface under the
prompt replaces all three, and the `widgetMode` setting that configured the
above-editor widget is gone.

Runs that enter through the scheduler or a cross-extension spawn appear in the
list too, alongside `Agent`-tool runs.

Every string these surfaces take from a child run — its description, activity preview, error, the `Agent` tool's own result and completion notification, and the conversation overlay's messages, tool results and command output — is text the extension did not author, so it is neutralized before rendering: terminal escape sequences are dropped, bidirectional overrides and other cursor-moving code points are shown as `[U+XXXX]`, and binary content is replaced with a placeholder. An agent file's `display_name` and `description` get the same treatment as they are loaded, since a cloned repository supplies them. A subagent that reads a poisoned file or fetches a hostile page cannot repaint or reorder the parent's terminal.

The token field is annotated with two optional signals inside parens:
- **`NN%`** — context-window utilization (color-coded: <70% dim, 70–85% warning, >=85% error). Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`compactions N`** — number of times the session has compacted, when greater than 0. Stays dim; the percent's color carries urgency.

### FleetView

While subagents are running, a Claude Code-style navigable list renders **below** the editor:

```
  Esc interrupt · ← agents · ↓ manage

  ● main · current
  ● general-purpose · Sleep then report 1 · running            11s · 13.1k tokens
  ● general-purpose · Sleep then report 2 · completed          11s · 13.1k tokens
  ✗ general-purpose · Sleep then report 3 · failed              4s · 2.1k tokens
  3 more below
```

Each row leads with a single-column status mark colored by outcome — `●` while a
run is live or finished cleanly, `✗` for a failure, `⊘` for one that was
stopped or aborted — so the column scans vertically without reading the labels.
The mark is a geometric shape rather than an emoji on purpose: an emoji invites
font fallback, and a fallback glyph is usually double-width, which would push
the rest of the row out of alignment on some terminals and not others.

The list is ordered earliest-launched first, and only shows agents you can actually open (pending/queued agents with no session yet appear once they start). At an **empty prompt**, press down or left to move focus from the prompt into the list. Up and down move the selection, Enter opens the selected agent's live conversation overlay (it auto-updates as the agent works), and Esc (or up above `main`) returns to the prompt. Selecting `main` returns to the normal view. The conversation overlay uses a complete `╭─╮` / `│` / `╰─╯` border. Press Enter to chat with a running agent — type a message and Enter to send it (Esc or an empty submit returns). For a queued agent that has no session yet, type `@handle message` in the main prompt; the message is delivered when it starts. Press `x` twice to stop a running agent. A viewer stays open when its agent finishes so you can read the final output, and finished agents linger in the list for a few seconds before dropping out. Typing anything at a non-empty prompt behaves normally — the list only captures navigation keys when the prompt is empty. Disable it entirely via `/agents → Settings → Fleet view`.

Individual agent results use restrained text status labels:

| State | Example |
|-------|---------|
| **Running** | `● running · turns 3 of 30 · tools 3 · 12.4k tokens (8%)` / `⠹ searching, reading 3 files...` |
| **Completed** | `● completed · turns 8 · tools 5 · 33.8k tokens (62%) · 12.3s` / `Done` |
| **Wrapped up** | `● wrapped up · turn limit · turns 50 of 50 · tools 50 · 89.1k tokens (84% · compactions 2) · 45.2s` / `Wrapped up at the turn limit` |
| **Stopped** | `⊘ stopped · turns 3 · tools 3 · 12.4k tokens (8%)` / `Stopped before completion` |
| **Error** | `✗ failed · turns 3 · tools 3 · 12.4k tokens (8%)` / `Error: timeout` |
| **Aborted** | `aborted · turns 55 of 50 · tools 55 · 102.3k tokens (95% · compactions 3)` / `Aborted at the turn limit` |

Completed results can be expanded (ctrl+o in pi) to show the full agent output inline.

By default, foreground and background agents each stream their full conversation to a per-subagent transcript — a JSON-lines file at `<os-tmpdir>/pi-subagents-<uid>/<cwd>/<session>/tasks/<agent-id>.output` (owner-only `0700`, cleared on reboot). Set `output_transcript: false` on a custom agent to write no transcript path or file for it, or set `outputTranscript: false` in `subagents.json` to make transcripts opt-in for the whole project (frontmatter overrides the project default). This governs **only** the transcript: it is independent of `persist_session` (the pi session on disk), and it does not affect `isolation: worktree` (which commits the agent's work to a git branch) or `memory:` (durable files) — set those accordingly if the goal is to keep a run off disk entirely. Background agent completion notifications render as styled text:

```
Find auth files · completed
  turns 3 · tools 3 · 12.4k tokens · 4.1s
  Found 5 files related to authentication...
  transcript: .pi/output/agent-abc123.jsonl
```

Group completions render each agent as a separate block. The LLM receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.

## Default Agent Types

| Type | Tools | Model | Prompt Mode | Description |
|------|-------|-------|-------------|-------------|
| `general-purpose` | all 7 | inherit | `append` (parent twin) | Inherits the parent's full system prompt — same rules, CLAUDE.md, project conventions |
| `Explore` | read, bash, grep, find, ls | haiku (falls back to inherit) | `replace` (standalone) | Fast codebase exploration (read-only) |
| `Plan` | read, bash, grep, find, ls | inherit | `replace` (standalone) | Software architect for implementation planning (read-only) |

The `general-purpose` agent is a **parent twin** — it receives the parent's entire system prompt plus a sub-agent context bridge, so it follows the same rules the parent does. Explore and Plan use standalone prompts tailored to their read-only roles.

Default agents can be **ejected** (`/agents` → select agent → Eject) to export them as `.md` files for customization, **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`), or **disabled** per-project with `enabled: false` frontmatter.

## Custom Agents

Define custom agent types by creating `.md` files. The filename becomes the agent type name. Any name is allowed — using a default agent's name overrides it.

Agents are discovered from three locations (higher priority wins):

| Priority | Location | Scope |
|----------|----------|-------|
| 1 (highest) | `.pi/agents/<name>.md` | Project — pi's config dir; authoritative, and where `/agents` writes |
| 2 | `.agents/agents/<name>.md` | Project — the shared cross-tool `.agents` workspace (same convention as `.agents/skills/`) |
| 3 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global — available everywhere |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project. If both project locations define the same name, **`.pi/agents/` wins** — `.pi` stays the project authority; `.agents/agents/` is an additional read location for projects that keep their agent assets in the `.agents` workspace. The global location follows Pi's `PI_CODING_AGENT_DIR` setting and can relocate all agent state.

Malformed or unreadable files are skipped with a path-qualified warning by default. If a malformed project file shadows a valid lower-priority definition with the same name, the loader warns which definition survived; set `strictAgentFiles: true` in `subagents.json` to fail closed during the first `session_start` instead. Strict validation and discovery use that session's `ctx.cwd`, not the process cwd, and a failed validation registers no root tools, manager, or RPC responder. Reloads after startup remain lenient; an accidental edit cannot terminate an active session. Unchanged warning keys are suppressed while their discovery root remains in the bounded 64-root cache; if that root is evicted, a later unchanged reload may warn again.
Interactive agent-file edits are compare-and-commit operations: replacements are written to a flushed temporary file, new files honor the process umask, and all mutations use a package-local, non-expiring atomic lock directory with bounded acquisition retries. Orphaned locks are never stolen; the error names the lock path to inspect/remove. Only writers using this protocol coordinate with these operations. Non-cooperating editors are detected when a content comparison observes their change, but portable Node has no universal filesystem CAS, so this is not a claim of an arbitrary-editor lock.

### Example: `.pi/agents/auditor.md`

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it like any built-in type:

```
Agent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Frontmatter Fields

All fields are optional — sensible defaults for everything.

| Field | Default | Description |
|-------|---------|-------------|
| `description` | filename | Agent description shown in tool listings |
| `display_name` | — | Display name for UI (e.g. the agent list, the conversation overlay) |
| `tools` | all 7 | Which tools the agent can call. Built-in names (`read, grep, …`), `*` / `all` (all built-ins), `none`, and `ext:<extension>` / `ext:<extension>/<tool>` selectors for extension tools. See [Tool & extension scoping](#tool--extension-scoping) below |
| `extensions` | `true` | Which extensions to load for the agent. `true` (all defaults), `false` (none), or an explicit list: `[mcp, "/abs/path.ts", "*"]`. See [Tool & extension scoping](#tool--extension-scoping) below |
| `exclude_extensions` | — | Extension denylist applied after `extensions:` — exclude wins. Plain names only (case-insensitive), no paths or `*`. Useful with `extensions: true` to drop one extension (e.g. `pi-notify`) |
| `skills` | `true` | Inherit skills from parent. Can be a comma-separated list of skill names to preload (see [Skill Preloading](#skill-preloading) for discovery locations) |
| `memory` | — | Persistent agent memory scope: `project`, `local`, or `user`. Auto-detects read-only agents |
| `disallowed_tools` | — | Comma-separated tools to deny even if extensions provide them |
| `isolation` | — | Set to `worktree` to run in an isolated git worktree |
| `tier` | none | This agent's default model tier, by name, from `agentTiers.profiles`. A tier passed at the call site overrides it. When set, it wins over `model`/`thinking` below — see [Model tiers](#model-tiers) |
| ~~`model`~~ | — | **Removed.** An agent no longer chooses its own model; use `tier`. A file that still has it loads normally, with a warning naming it — the line simply has no effect |
| ~~`thinking`~~ | — | **Removed**, same as `model` above |
| `max_turns` | unlimited | Max agentic turns before graceful shutdown. `0` or omit for unlimited |
| `persist_session` | `false` | Persist this subagent as a normal pi session instead of keeping the session in memory only. The subagent's `.output` transcript is still written either way unless `output_transcript: false` |
| `output_transcript` | `true` (or `subagents.json` `outputTranscript`) | Write this subagent's `.output` transcript; when set, overrides the `subagents.json` `outputTranscript` default. Set `false` to write no transcript file or path. Governs only the transcript — independent of `persist_session`, `isolation: worktree`, and `memory:` |
| `session_dir` | pi default | Optional session directory when `persist_session: true`; omitted uses pi's normal session location, and relative paths resolve from the agent cwd |
| `allowed_subagents` | none | Opt in to scoped nested `Agent`, `get_subagent_result`, and `steer_subagent` tools. Omitted / empty / `none` / `false` = no nesting; `all` (or `"*"` / `true`) = any enabled agent; comma-separated list = only those agent types |
| `prompt_mode` | `replace` | `replace`: body is the full system prompt (no AGENTS.md / CLAUDE.md inheritance). `append`: body appended to parent's prompt (agent acts as a "parent twin" — inherits parent's AGENTS.md / CLAUDE.md) |
| `inherit_context` | `false` | Fork parent conversation into agent |
| `run_in_background` | `false` | Run in background by default |
| `isolated` | `false` | Hermetic specialist mode: forces `extensions: false` + `skills: false` + drops `ext:` selectors. Only built-in tools. Distinct from `isolation: worktree` (filesystem) |
| `enabled` | `true` | Set to `false` to disable an agent (useful for hiding a default agent per-project) |

Frontmatter is authoritative. If an agent file sets `model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`, `isolated`, or `isolation`, those values are locked for that agent. `Agent` tool parameters only fill fields the agent config leaves unspecified.

**Forgiving `model:` resolution.** A `model:` pin is matched against pi's model registry tolerantly, so cosmetic id variations don't silently drop the agent back to the parent's model: `.` and `-` are treated as equivalent in version numbers (`claude-haiku-4.5` ≡ `claude-haiku-4-5`), a trailing `-YYYYMMDD` date stamp is optional (`anthropic/claude-haiku-4-5-20251001` matches an undated registry id and vice-versa), and a `provider/modelId` whose named provider doesn't carry that model retries the bare id against every provider. Precedence is **exact → fuzzy under the named provider → same model under any provider → unavailable**, so an exact match always wins and dated snapshots aren't conflated. If nothing resolves, the pin can't run and the agent inherits the parent model — `/agents → Agent types` flags this case as `(unavailable, fallback: inherit)` and shows the resolved target `(→ provider/id)` when resolution lands on a different provider or version than configured. (This is distinct from [Model Scope](#model-scope) enforcement, which matches the `enabledModels` allowlist by *exact* entry.)

### Nested subagents

Nested delegation is default-off. Set `allowed_subagents` only on a non-isolated custom agent that owns a real fan-out responsibility:

```yaml
---
tools: read, grep, find
extensions: false
allowed_subagents: support-file-finder, support-callsite-tracer   # or `all`
---
```

**The allowlist is a privilege boundary, not just a routing hint.** A child runs with *its own* `tools:`, `extensions:`, and `isolated:` — the parent's restrictions are not inherited — so delegation grants the parent the union of what the listed agents can do. The read-only agent above can write and run commands through any listed agent that can, and `all` reaches every enabled agent including `general-purpose`. Choose the list as carefully as you would choose `tools:` itself; that is the main reason this is default-off.

`allowed_subagents` is runtime-enforced. A comma-separated list restricts nesting to those types; `all` (or `"*"` / `true`, matching how `extensions:` and `skills:` take booleans) allows any enabled agent; omitted, empty, `none`, or `false` means no nested tools are injected at all. Unknown, disabled, and out-of-list types are rejected rather than falling back — regardless of the project's [fallback agent](#persistent-settings) setting, so a configured fallback can never hand a nested caller an agent outside its allowlist — and a nested `model:` is validated against [Model Scope](#model-scope) exactly like a top-level spawn. Result, resume, and steering operations are ownership-scoped, so a parent can control only its own children. Nested records remain internal to that parent and do not appear in top-level tools, lifecycle events, or agent UI — so when a parent finishes, is stopped, or ends a resumed turn, its nested children are stopped with it. They do write their own `.output` transcript (subject to the same `output_transcript` gate), filed under the root session's directory alongside their ancestors', so a nested run can still be inspected after the fact. Their token usage is folded into every ancestor's totals up to the top-level agent (lifecycle events, completion notifications, `/agents`), so nested spend stays attributable at any depth even though the children themselves stay hidden. A nested result that ends `stopped`, `aborted`, or `steered` is labelled as partial, the same guarantee top-level results carry.

The hard cap is depth 2 by default: main session (0) → subagent (1) → nested child (2). Change it project-wide with `maxSubagentDepth` in `subagents.json` (or `/agents → Settings → Nested depth`); `0` or `1` turns nesting off everywhere. An agent already at the cap gets no nested tools at all — not even `get_subagent_result`, since it can never own a child. A child must independently set `allowed_subagents` to delegate again; isolated agents never receive nested tools.

Nested children don't occupy `maxConcurrent` slots — their parent already holds one, and queueing them behind it would deadlock a parent waiting on its own child. The depth cap bounds how *deep* nesting goes, not how *wide*: a parent's only limit on concurrent children is that each spawn costs it a turn. Pair `allowed_subagents` with a `max_turns` on that agent if you want a hard ceiling on its fan-out.

Because a subagent session never activates this extension (that is what keeps a child from building a second agent manager, and it is why nested tools are injected directly instead), a subagent also gets none of the extension's other surfaces: no `/agents` command, no cross-extension RPC handlers, no `subagents:ready` event.

### Tool & extension scoping

`extensions:` decides **which extensions load**, `tools:` decides **which tools surface to the LLM**. They compose:

```yaml
# Default (both omitted): all extensions load, all 7 built-ins surface

tools: read, grep, find           # narrow to listed built-ins; extensions still load
tools: "*"                        # all 7 built-ins (alias: `all`)
tools: none                       # zero built-ins (alias: `""`)
tools: "*, ext:mcp/search"        # built-ins plus one extension tool

extensions: false                 # no extensions load
extensions: [mcp]                 # only mcp loads
extensions: ["*", "/abs/foo.ts"]  # all defaults plus one path-loaded extension

exclude_extensions: pi-notify     # everything except pi-notify (with extensions: true)

# Specialist: load one extension, expose only one of its tools, keep built-ins
extensions: [mcp]
tools: "*, ext:mcp/search"

isolated: true                    # hermetic: built-ins only, no extensions/skills/context
```

A few rules the examples don't make obvious:

- `extensions:` is the sole loading authority. `ext:foo` in `tools:` narrows what surfaces; it can't load `foo` on its own. Mismatches fire `extension-error:…` warnings.
- Any `ext:` entry flips extension tools to an explicit allowlist — unnamed extensions still load (handlers fire) but expose no tools. So `tools: "*, ext:mcp/search"` exposes only `search` from `mcp`, nothing from any other extension.
- Extension names match case-insensitively (`[Mcp]` = `[mcp]`); tool names in `ext:foo/bar` stay case-sensitive.
- Extensions that register tools **lazily** work too. MCP-backed extensions typically can't enumerate their tools until their servers connect, so they register from `session_start` or `before_agent_start` rather than at load. Subagent scoping is re-derived as tools appear, so these surface normally — including under `ext:` selectors, which keep narrowing correctly no matter when a tool shows up.
- An installed **package** extension matches by its package short name (`@scope/pi-subagents` → `[pi-subagents]`), in addition to its path-derived name (a package whose entry is `src/index.ts` also answers to `[src]`). Prefer the package name — the path-derived one is incidental.
- Plain `tools:` typos fail loudly: `tools: reed, grep` fires `tools-error:…` instead of silently producing an under-tooled agent.
- `exclude_extensions:` wins over `extensions:` and over `ext:` selectors — an excluded extension never loads and a `tools: ext:` entry can't pull it back. Plain names only (no paths, no `*`); a name matching nothing fires an `extension-error:…` warning.
- `exclude_extensions:` is **not a sandbox**: excluded extensions' factory code still executes once during loading. Exclusion suppresses their tools and their bound lifecycle hooks (`pi.on` handlers like `session_start` only fire for extensions bound to the session), but not other load-time side effects — a factory that subscribes directly to the shared `pi.events` bus stays live. Don't rely on it to contain an untrusted extension.
- Array and string forms are equivalent: `[a, b]` == `"a, b"`.

## Tools

### `Agent`

Launch a sub-agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The task for the agent |
| `description` | string | yes | Short 3-5 word summary (shown in UI) |
| `subagent_type` | string | yes | Agent type (built-in or custom) |
| `tier` | string | no | Model tier for this spawn, by name. Overrides the agent's own default tier. Unknown tiers are rejected, not substituted — see [Model tiers](#model-tiers) |
| `max_turns` | number | no | Max agentic turns. Omit for unlimited (default) |
| `run_in_background` | boolean | no | Run without blocking |
| `resume` | string | no | Agent ID to resume a previous session |
| `isolated` | boolean | no | No extension/MCP tools |
| `isolation` | `"worktree"` | no | Run in an isolated git worktree |
| `inherit_context` | boolean | no | Fork parent conversation into agent |

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to check |
| `wait` | boolean | no | Wait for completion |
| `verbose` | boolean | no | Include full conversation log |

Cancelling a `wait: true` call (for example, with `Esc`) stops only the wait. The background agent keeps running, and its completion notification still arrives normally.

### `steer_subagent`

Send a chat message to a running or queued agent. A running agent receives it after the current tool execution; a queued agent receives it when its session starts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_id` | string | yes | Agent ID to steer |
| `message` | string | yes | Message to inject into agent conversation |

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Interactive agent management menu |

The `/agents` command opens an interactive menu:

```
Agent runs (2) · 1 running · 0 queued · 1 completed · 0 wrapped up · 0 stopped · 0 aborted · 0 failed
Agent types (6) · unified list of defaults and custom agents
Model tiers (3) · the (model, thinking) catalogue
Create new agent
Settings
```

- **Agent runs** — select any retained run with a session to open its conversation viewer. Queued runs without a session remain listed but are not openable until they start; selecting one offers a stop confirmation, and `@handle message` queues a chat message. The summary reports running, queued, completed, wrapped up, stopped, aborted, and failed buckets separately. While a run is still active, press Enter to open the chat composer, then Enter again to send a message that redirects the agent (same mechanism as the `steer_subagent` tool; Esc or an empty submit returns), or press `x` (then `x` again to confirm) to stop/abort it — including **background** agents, which a global Esc can't unambiguously target (Esc still stops a blocking foreground `Agent` call). A stopped agent reports its partial output flagged as incomplete, not as a completion.
- **Agent types** — unified list with textual source labels (`project`, `global`, and `disabled`). Each row shows the agent's model, and the highlighted agent's full description appears below the list. The model column flags `(unavailable, fallback: inherit)` when a configured model can't be resolved (it would silently inherit the parent model), and shows `(resolved: provider/id)` when it resolves to a different provider or version than configured. Select an agent to manage it:
  - **Default agents** (no override): Eject (export as `.md`), Disable
  - **Default agents** (ejected/overridden): Edit, Disable, Reset to default, Delete
  - **Custom agents**: Edit, Disable, Delete
  - **Disabled agents**: Enable, Edit, Delete
- **Eject** — writes the embedded default config as a `.md` file to project or personal location, so you can customize it
- **Disable/Enable** — toggle agent availability. Disabled agents stay visible in the list with a `disabled` label and can be re-enabled
- **Create new agent** — choose project/personal location, then manual wizard (step-by-step prompts for name, tools, model, thinking, system prompt) or AI-generated (describe what the agent should do; a sub-agent writes a unique same-directory staging file, and the parent parses and compare-commits it to the target). Any name is allowed, including default agent names (overrides them)
- **Model tiers** — create, edit and delete the [tier](#model-tiers) profiles. Each row shows what the tier resolves to on this machine (`small — claude-haiku-4-5 · thinking max`), and a tier dropped as malformed is listed as `blocked` so it can be fixed rather than staying invisible. The model picker offers this machine's available models (narrowed to your scope when **Scope models** is on) plus `inherit` and a typed escape hatch; the thinking picker offers only the levels the chosen model actually supports, since the rest would be silently clamped at spawn. Deleting the tier that `defaultTier` names clears the default in the same step
- **Settings** — configure max concurrency, default max turns, grace turns, default model, default tier, and join mode at runtime

## Graceful Max Turns

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At `max_turns` — steering message: *"Wrap up immediately — provide your final answer now."*
2. Up to 5 grace turns to finish cleanly
3. Hard abort only after the grace period

| Status | Meaning | UI treatment |
|--------|---------|-------------|
| `completed` | Finished naturally | `completed` |
| `steered` | Wrapped up at the limit; output may be partial | `wrapped up · turn limit` in warning color |
| `aborted` | Grace period exceeded | `aborted` in warning color |
| `stopped` | User-initiated abort | `stopped` |

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4). Excess agents are automatically queued and start as running agents complete. Queued agents appear in the list once they start.

Foreground agents bypass the queue — they block the parent anyway.

## Join Strategies

When background agents complete, they notify the main agent. The **join mode** controls how these notifications are delivered. It applies only to background agents.

| Mode | Behavior |
|------|----------|
| `smart` (default) | 2+ background agents spawned in the same turn are auto-grouped into a single consolidated notification. Solo agents notify individually. |
| `async` | Each agent sends its own notification on completion (original behavior). Best when results need incremental processing. |
| `group` | Force grouping even when spawning a single agent. Useful when you know more agents will follow. |

**Timeout behavior:** When agents are grouped, a 30-second timeout starts after the first agent completes. If not all agents finish in time, a partial notification is sent with completed results and remaining agents continue with a shorter 15-second re-batch window for stragglers.

**Configuration:**
- Configure join mode in `/agents` → Settings → Join mode

## Model tiers

An **Agent tier** is one name for a (model, thinking) pair. The host agent picks a
tier by name and nothing else: the `Agent` tool exposes `tier` and does **not**
expose `model` or `thinking`, so which model runs is decided by the Agent-tier
catalogue rather than by the orchestrator improvising per call.

Names are yours. The names below are only an example — `research`,
`cheap`, `nightly` are equally valid keys. Replace the illustrative provider/model
values with models available in your environment.

```json
{
  "agentTiers": {
    "defaultTier": "medium",
    "profiles": {
      "low":      { "description": "Fast, cheap exploration",       "model": "provider/fast-model", "thinking": "max" },
      "medium":   { "description": "Ordinary planning and review",  "model": "provider/reasoning-model", "thinking": "max" },
      "high":     { "description": "Architecture and risky review", "model": "provider/architecture-model", "thinking": "xhigh" },
      "research": { "description": "Long-context research",         "model": "provider/long-context-model", "thinking": "max" }
    }
  }
}
```

A profile is all-or-nothing: both `model` and `thinking` are required, and either
may be the literal `"inherit"` to keep the parent's. `description` is optional and
defaults to the key; it is what the host reads when choosing between Agent tiers.

### One catalogue, including for workflows

A managed `pi-workflows` call names a key from this same `agentTiers` catalogue.
There is no second workflow-tier vocabulary and no mapping layer: a workflow that
wants cheap work asks for the tier you defined for cheap work.

```js
// in a workflow script
await agent("summarize this diff", { tier: "low" })
await agent("design the migration", { tier: "high" })
```

The tier is resolved by the same `resolveAgentTier()` path an ordinary Agent
spawn uses — same precedence, same model lookup, same thinking clamping, same
availability checks, same immutable resolution snapshot. A tier the host does not
define is rejected before dispatch, naming the tiers it does define.

Model and thinking are deliberately absent from the managed request. A tier is
the only model policy a workflow can express, so there is no second selector that
could silently win or be silently ignored.

Fresh installs ship an effort ladder: `low`, `medium`, `high`. Every shipped
profile inherits its model, so a new machine gets a working vocabulary without
this package ever choosing a vendor for you. A managed call that names no tier
uses the agent's own tier, then `agentTiers.defaultTier`, and finally falls back
to `medium` so a workflow runs on an unconfigured machine.

`medium` inherits its model, so on an unconfigured machine that fallback runs on
the parent session's model. What it buys is a call with a *named* policy, a
durable resolution snapshot and a scope check — not cheaper work. If you want
managed work to run somewhere cheaper, set a `defaultTier` whose profile pins a
model.

That last fallback is scoped to managed calls. It is deliberately **not** the
catalogue's `defaultTier`: a shipped default that applied to every ordinary spawn
would silence [`defaultModel`](#defaultmodel) and pin a thinking level on machines
that configured neither.

So `Default tier` has three settings, not two, and the menu offers all three:

| Setting | Ordinary spawn | Managed workflow call |
| --- | --- | --- |
| a tier name | that tier | that tier |
| `unset` | `defaultModel`, then the parent session | the shipped `medium` |
| `none` | `defaultModel`, then the parent session | rejected |

`none` is a policy statement, recorded as `noDefaultTier`; `unset` is the absence
of one. Deleting the profiles has the same effect on managed calls as `none`.

### How the host discovers tiers

The catalogue is rendered into the `Agent` tool description at registration, so
the host knows the vocabulary before its first call — there is no lookup tool to
remember. It sees:

```
Available agent tiers:

- low: Fast, cheap exploration
  model: provider/fast-model
  thinking: max
...
Default tier: medium

The caller may pass only a tier key. Do not pass model or thinking directly.
```

A [custom tool description](#persistent-settings) can place it with
`{{tierList}}`, `{{compactTierList}}` or `{{defaultTier}}`. Tier changes apply on
the next pi session, since the description is built once at registration.

### Precedence

1. `tier` passed to the `Agent` call
2. `tier:` in the agent's frontmatter
3. `agentTiers.defaultTier`
4. `defaultModel` — a model with no tier attached, for workspaces that want one
   setting rather than a catalogue
5. the parent session's model and thinking

An agent cannot pin its own model at any step. `model:`/`thinking:` in
frontmatter are read only to warn that they are stale, and the built-in agents
pin nothing either. With nothing configured at all, a subagent runs on the
parent session's model.

A **managed workflow call** cannot take steps 4 and 5 — it has no parent session
to inherit from — so it gets one extra step between 3 and the end: the shipped
`medium` fallback. That step exists only for callers that would otherwise fail
closed, which is why it does not displace `defaultModel` for everyone else.

### `defaultModel`

Steps 1–3 are a catalogue; step 4 is one line. Set it when the whole point is
"subagents run on the cheap model" and there is no second policy to name:

```json
{ "defaultModel": "anthropic/claude-haiku-4-5" }
```

It only decides the model — thinking still comes from the parent, because a
level nobody chose for a specific model is exactly what a tier exists to
express. Any tier that applies overrides it outright.

Set it from `/agents → Settings → Default model` (Enter opens the picker), or by
hand. It accepts the same references a tier's `model` does, plus the literal
`"inherit"`, which is how a project cancels a global `defaultModel` — omitting
the key inherits whatever the global file set.

Unlike a tier, an unresolvable `defaultModel` does **not** fail the spawn: it
falls back to the parent model, and the Settings row shows
`(unavailable, fallback: inherit)`. A tier is refused because someone named that
policy at the call site; `defaultModel` is the value nobody named, so one
unauthed provider must not take every spawn on the machine down with it.

### Editing tiers

`/agents → Model tiers` manages the catalogue — new tier, change a tier's model,
thinking or description, delete one. `defaultTier` lives with the other defaults
in `/agents → Settings → Default tier`. Both write the project file; the global
file is never written from the menu.

Two things the menu knows that a hand-edited file does not: the thinking picker
offers only levels the chosen model supports (the rest get clamped at spawn
anyway), and a tier dropped as malformed still appears in the list, marked
`blocked`, so redefining it is one selection rather than an archaeology
expedition through `subagents.json`.

The `Agent` tool description is built once at registration, so a tier edit
reaches the model on the next pi session. Resolution itself is live — a spawn
right after the edit already uses the new profile.

One thing the file format cannot express: a project *deleting* a tier that only
the global file defines. The menu writes the merged catalogue back to the
project file, so deleting one of several works, but deleting the last one — or
clearing a `defaultTier` that only global sets — leaves no `agentTiers` key
behind, and the global value is inherited again on the next start. Remove it
from `~/.pi/agent/subagents.json` instead. The same is true of `workflow.tiers`.

### Refusals

A `defaultTier`, or an agent's `tier:`, that names no defined profile is
reported at **startup**, listing the available keys — a typo there would
otherwise sit quiet until the first spawn that needed it, possibly minutes into
a session.

These fail **before** the spawn, with the tier key and where it came from named.
None of them silently substitutes another model:

- a tier key nobody defined (from the call, the agent file, or `defaultTier`)
- a profile dropped as malformed during settings load
- a profile whose model is not available on this machine
- a syntactically invalid key (blank, whitespace, over 64 characters)

### Merging global and project settings

`~/.pi/agent/subagents.json` supplies the catalogue; `<cwd>/.pi/subagents.json`
edits it. A project profile replaces its global namesake **whole** — never field
by field, which would let a project change a model while inheriting a thinking
level nobody chose for that pair. A project profile that fails validation blocks
its global namesake rather than reviving it, and `defaultTier` is a simple
project-over-global override.

### Migrating from `model:`/`thinking:`

Define the Agent-tier profiles once, then replace each agent's `model:`/`thinking:`
with `tier: <name>`. Files that still carry the old fields load and run — the
fields are ignored, with a warning naming the file — so the migration can be done
one agent at a time. Until an agent names a tier it uses `agentTiers.defaultTier`,
then `defaultModel`, or the parent's model when none is set.

Programmatic callers and the legacy RPC may still pass `model`/`thinking`
directly. That is the escape hatch for code, not a way to configure an agent.

## Model Scope

**Opt-in:** off by default. Enable via `/agents → Settings → Scope models`.

When on, each subagent spawn's effective model is validated against pi's own `enabledModels` list (configured via pi's `/scoped-models` UI). pi-subagents reads that list; it doesn't manage it. Both of pi's settings files are honored: global `~/.pi/agent/settings.json` and project-local `<cwd>/.pi/settings.json`. **Project overrides global** — mirrors pi's `SettingsManager` deep-merge, so a tighter per-project scope (hand-edited into the project settings) is respected.

**Out-of-scope handling depends on source:**

| Model source | Out-of-scope behavior |
|---|---|
| Caller-supplied programmatic `model` (only when no Agent tier applies) | Hard error returned to the orchestrator, listing allowed models |
| Pinned in agent frontmatter | Warning toast + the pinned model runs (frontmatter is authoritative) |
| Parent-inherited (neither set) | Warning toast + parent's model runs |

**Design:** `scopeModels` is a guardrail against unexpected runtime model choices, not a hard policy against user-level config. An applicable Agent tier is checked after its single final resolution; compatibility model inputs are checked only on the no-tier path and cannot override a tier.

**Nested spawns** ([nested subagents](#nested-subagents)) apply the same table against the parent's config root. The hard-error case is identical; the warning cases proceed silently, since a subagent session has no UI to toast to.

**Pattern format:** only exact `provider/modelId` entries are honored (e.g. `anthropic/claude-haiku-4-5-20251001`). Glob patterns (`*sonnet*`), bare model IDs, and `:thinking` suffixes — which pi itself supports — are silently dropped here. pi's `/scoped-models` picker writes exact entries, so the limitation is invisible if you configure scope through the UI. Hand-edited globs produce an empty allowed set (scope check becomes a no-op).

**No-op safety:** if `enabledModels` is missing or empty in pi's settings, scope check skips entirely — no false positives, no spurious errors.

## Persistent Settings

Runtime tuning values set via `/agents` → Settings (max concurrency, default max turns, grace turns, nested depth, fallback agent, default model, default tier, default join mode, scheduling on/off, scope models on/off, strict agent files on/off, disable defaults on/off, output transcript on/off, tool description full/compact/custom, fleet view on/off) persist across pi restarts. Two files, merged on load:

- **Global:** `~/.pi/agent/subagents.json` — your machine-wide defaults. Edit by hand; the `/agents` menu never writes here.
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides. Written by `/agents` → Settings.

**Precedence:** project overrides global on any field present in both. Missing fields fall back to the hardcoded defaults (max concurrency `4`, default max turns unlimited, grace turns `5`, nested depth `2`, join mode `smart`, defaults enabled).

The `workflow` settings key is **retired**. Managed `pi-workflows` calls name an `agentTiers` key directly, so there is no separate workflow routing table; a file that still has one is ignored with a warning naming the key. `agentTiers.defaultTier` replaces what `workflow.defaultTier` used to do. See [One catalogue, including for workflows](#one-catalogue-including-for-workflows).

**Default model** (`defaultModel`, unset): the model a non-tiered ordinary subagent runs — see [`defaultModel`](#defaultmodel) for where it sits in precedence, why an unresolvable value falls back instead of failing, and how `"inherit"` lets a project cancel a global default. **Default tier** (`agentTiers.defaultTier`, unset) is the tier applied when neither the caller nor the agent names one; the profiles it selects from live under [`agentTiers`](#model-tiers). It has three settings — a tier name, `unset`, and `none` — which the menu offers separately because the last two behave differently for managed workflow calls; see [Model tiers](#model-tiers) for the table.

**Strict agent files** (`strictAgentFiles`, default `false`): normal startup skips unreadable or malformed agent definitions with a warning that includes the file path. Enable it to fail closed during the first `session_start`, using that session's `ctx.cwd`, with the path in the error instead of silently running a surviving lower-priority override. A failed validation leaves no root manager or RPC responder behind. Reloads after startup remain lenient, so an accidental edit cannot terminate an active session; the setting applies on the next pi session.

**Nested depth** (`maxSubagentDepth`, default `2`): the hard ceiling on [nested delegation](#nested-subagents), counted from the main session (main = 0, its subagents = 1). `0` or `1` disables nesting project-wide regardless of any agent's `allowed_subagents`. Read when a subagent session is built, so a change applies to agents started after it.

**Fallback agent** (`fallbackSubagent`, default `general-purpose`): the agent used when a caller-supplied `subagent_type` doesn't resolve to exactly one enabled agent — unknown, disabled, or ambiguous because two agents differ only by case. Name any enabled agent to route those calls there instead, or set `none` for **strict**, fail-closed dispatch: the call is refused with an error listing the available types, and nothing spawns. Strict mode matters most for background and scheduled calls, which would otherwise start executing a substituted agent before the caller learns anything. Also settable from `/agents → Settings → Fallback agent`. The boolean `false` is accepted as a spelling of `none`, because it would otherwise be dropped as the wrong type and silently leave the permissive default in place. Every other value is read as an agent name, so a mistaken `off` fails loudly at dispatch rather than meaning one thing in the settings file and another in the resolver. A fallback agent that is itself unknown or disabled is a misconfiguration and is reported rather than quietly replaced. Note the default is unchanged and stays permissive by design: with `disableDefaultAgents` and no `general-purpose` of your own, an unresolvable type still resolves to a built-in config carrying *all* tools — set `none` (or name one of your own agents) to close that.

**Disable defaults** (`disableDefaultAgents`, default `false`): when on, the three built-in agents (general-purpose, Explore, Plan) are not registered — only your project/global custom agents are advertised and spawnable. User-defined agents are unaffected, including ones that override a default by name. The Agent tool's type list updates on the next pi session (the tool schema is registered at startup).

**Output transcript** (`outputTranscript`, default `true`): the project/global default for writing each subagent's `.output` transcript. Toggle via `/agents → Settings → Output transcript`, or set `false` in `subagents.json` to make transcripts opt-in project-wide — useful when run transcripts shouldn't sit on disk for backup or DLP tooling to pick up. A custom agent's `output_transcript` frontmatter overrides this per agent. Applied live at spawn time. Governs only the transcript, not `persist_session`, worktree commits, or memory files.

**Tool description** (`toolDescriptionMode`, default `"full"`): which Agent tool description the LLM sees. `"full"` is the rich Claude Code-style prompt (~1,400 tokens with the default agents); `"compact"` is ~75% smaller — one-line agent type list, terse usage notes — for small/local models where tool-spec tokens are expensive. Per-option details stay in the parameter descriptions in every mode (the parameter schema is never customizable). Applies on the next pi session.

`"custom"` registers your own description from `<cwd>/.pi/agent-tool-description.md` (project) or `<agentDir>/agent-tool-description.md` (global; project wins). The file is read once at tool registration, so edits also apply on the next pi session. Dynamic parts stay live via placeholders — a static agent list would go stale the moment you add a custom agent:

```markdown
Launch an autonomous agent. Available types:
{{typeList}}

Custom agents live in .pi/agents/ or {{agentDir}}/agents/.
```

Placeholders: `{{typeList}}` (full per-agent descriptions), `{{compactTypeList}}` (first sentence each), `{{agentDir}}`, `{{scheduleGuideline}}` (expands with its own leading newline + `- ` bullet when scheduling is on — place it directly after your last rule line; empty when scheduling is off). Unknown placeholders are left verbatim with a stderr warning; a missing or empty file falls back to `"full"` with a warning. Note the usual trust umbrella: a project-level file shapes the orchestrator's prompt, same as project agents and extensions do.

**Starting point:** copy [`examples/agent-tool-description.md`](examples/agent-tool-description.md) — it reproduces the default full description exactly (a CI test keeps it in sync), so you can trim from a known-good baseline instead of writing from scratch.

**Example — global defaults for a beefy machine:**

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "graceTurns": 10
}
EOF
```

Every project now starts with concurrency 16 and grace 10, without ever touching the menu. Individual projects can still override via `/agents` → Settings.

**Failure behavior:** missing file is silent; malformed JSON logs a `[pi-subagents] Ignoring malformed settings at …` warning to stderr; invalid/out-of-range field values are dropped per-field; write failures downgrade the `/agents` toast to a warning with `(session only; failed to persist)`.

## Events

Agent lifecycle events are emitted via `pi.events.emit()` so other extensions can react:

| Event | When | Key fields |
|-------|------|------------|
| `subagents:created` | Background agent registered | `id`, `type`, `description`, `isBackground`, optional `owner` |
| `subagents:started` | Agent transitions to running (including queued→running) | `id`, `type`, `description`, optional `owner` |
| `subagents:completed` | Agent finished successfully (background and foreground) | `id`, `type`, `durationMs`, `tokens` (lifetime `{ input, output, total }`), `toolUses`, `result`, optional `outputFile`/`owner` |
| `subagents:failed` | Agent errored, stopped, or aborted (background and foreground) | same as completed + `error`, `status`, optional `outputFile`/`owner` |
| `subagents:steered` | Steering message sent | `id`, `message` |
| `subagents:compacted` | Agent's session successfully compacted | `id`, `type`, `description`, `reason` (`"manual"` / `"threshold"` / `"overflow"`), `tokensBefore`, `compactionCount`, optional `owner` |
| `subagents:scheduled` | Schedule lifecycle change | `{ type: "added" \| "removed" \| "updated" \| "fired" \| "error", … }` (job/agentId/error fields per type) |
| `subagents:scheduler_ready` | Scheduler bound to session, enabled jobs armed | `sessionId`, `jobCount` |
| `subagents:ready` | RPC handlers registered and armed — fired on session start; not emitted in a session that excludes pi-subagents | `version: 4`, `capabilities` (`managedSpawn`, `lifecycleOwner`, `ownedStop`, `ownedQuiescence`, `childContext`, `agentTiers`, `managedPolicy` — all required), `routingPolicy` (Agent-tier catalogue + fingerprint) |
| `subagents:settings_loaded` | Persisted settings applied at extension init | `settings` (merged global + project) |
| `subagents:settings_changed` | `/agents` → Settings mutation was applied | `settings`, `persisted` (`boolean` — `false` on write failure) |

`tokens.total` = `input + output + cacheWrite`. `cacheRead` is excluded — each turn's `cacheRead` is the cumulative cached prefix re-read on that one API call, so summing per-message would over-count it. Use `contextUsage.percent` (surfaced as `(NN%)` in the agent list) for current context size.

## Cross-Extension RPC

Other pi extensions can spawn and stop subagents programmatically via the `pi.events` event bus, without importing this package directly.

All RPC replies use a standardized envelope: `{ success: true, data?: T }` on success, `{ success: false, error: string }` on failure.

### Discovery

Listen for `subagents:ready` to know when RPC handlers are available:

```typescript
pi.events.on("subagents:ready", () => {
  // RPC handlers are registered — safe to call ping/spawn/stop
});
```

`subagents:ready` fires only when pi-subagents is actually loaded **and bound** in the current session. A session that excludes it (via an agent's `extensions:`) emits no `subagents:ready` and does not answer the RPC channels — exactly as if pi-subagents were not installed. Treat "no `subagents:ready`" as "not available here" and give discovery a timeout rather than waiting indefinitely.

### Ping

Check if the subagents extension is loaded and get the protocol version and current routing-policy fingerprint:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (reply) => {
  unsub();
  if (reply.success) console.log("Protocol version:", reply.data.version, "routing policy:", reply.data.routingPolicy.fingerprint);
});
pi.events.emit("subagents:rpc:ping", { requestId });
```

### Managed spawn (protocol v4)

Workflow-owned orchestration uses the `subagents:rpc:spawn-managed` channel. Its request may include the core identity fields plus an optional Agent `tier`, `toolset`, `excludeTools`, `thread`, and `isolation: "worktree"`. There is no per-call `model` or `thinking` — the wire validator rejects them:

```json
{
  "requestId": "request-1",
  "spawnKey": "run-id/node-id/attempt-1",
  "type": "Explore",
  "prompt": "Find the relevant files",
  "description": "Find relevant files",
  "tier": "low",
  "excludeTools": ["workflow", "workflow_control"],
  "isolation": "worktree",
  "owner": { "extension": "pi-workflows", "runId": "run-id", "nodeId": "node-id", "attemptId": "run-id/node-id/attempt-1" }
}
```

The manager validates and resolves the tier, agent configuration, queue, tool, session, and worktree policy against its own Agent-tier catalogue and model scope. The resolved tier and its snapshot are retained on the managed invocation/tombstone. `spawnKey` is idempotent within a root manager; the same normalized request returns the existing agent id and a conflicting request is rejected. A named managed `thread` re-enters one sequential session only while its effective model, thinking, toolset, denylist, isolation, and agent policy fingerprint remain unchanged — including the model and thinking its tier currently resolves to, so switching the session model interrupts a thread whose tier inherits it; a policy change or concurrent call is rejected rather than silently reusing the old session. Managed agents use the normal Agent execution path, queue, FleetView, activity, transcript, compaction, and lifecycle events. Only the automatic main-session completion nudge is suppressed for an owner-scoped record. Managed requests must carry an attempt-scoped owner, and `stop-owned`/`quiesce-owned` fail closed when exact node/generation metadata is missing. During branch replacement, timed-out records are detached and late callbacks are suppressed.

### Spawn

Spawn a subagent and receive its ID:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) {
    console.error("Spawn failed:", reply.error);
  } else {
    console.log("Agent ID:", reply.data.id);
  }
});
pi.events.emit("subagents:rpc:spawn", {
  requestId,
  type: "general-purpose",
  prompt: "Do something useful",
  options: { description: "My task", run_in_background: true },
});
```

`options.model` accepts either a `Model` object (e.g. `ctx.model`) or a `"provider/modelId"` string — strings are resolved against `ctx.modelRegistry` at the RPC boundary, so cross-extension callers can forward serializable values without losing auth context.

`options.cwd` (absolute path to an existing directory — anything else returns an error envelope; `null` means unset) runs the agent in a different working directory than the parent session. Its tools operate there and the prompt's environment block describes it, but **`.pi` config still loads from the parent session's project** — the target directory's `.pi` extensions never execute, and its agents/skills/settings are not picked up. Combined with `isolation: "worktree"`, the worktree is created *from* the target directory's repo, the agent works at the equivalent subdirectory inside the copy (a monorepo-package cwd stays scoped to that package), and the resulting `pi-agent-*` branch lands in that repo — the completion message names it. On session end, worktree registrations are pruned in every repo that received one; only a hard crash can leave a stale entry (then: `git worktree prune` in the target repo). Agents with `memory:` keep reading/writing the parent project's memory.

### Stop

Stop a running agent by ID:

```typescript
const requestId = crypto.randomUUID();
const unsub = pi.events.on(`subagents:rpc:stop:reply:${requestId}`, (reply) => {
  unsub();
  if (!reply.success) console.error("Stop failed:", reply.error);
});
pi.events.emit("subagents:rpc:stop", { requestId, agentId: "agent-id-here" });
```

Reply channels are scoped per `requestId`, so concurrent requests don't interfere.
Workflow callers should pass a foreground signal only to their own wait. Managed child cancellation is explicit through the owner-scoped lifecycle RPC; aborting an RPC wait does not abort the child.

## Persistent Agent Memory

Agents can have persistent memory across sessions. Set `memory` in frontmatter to enable:

```yaml
---
memory: project   # project | local | user
---
```

| Scope | Location | Use case |
|-------|----------|----------|
| `project` | `.pi/agent-memory/<name>/` | Shared across the team (committed) |
| `local` | `.pi/agent-memory-local/<name>/` | Machine-specific (gitignored) |
| `user` | `<agentDir>/agent-memory/<name>/` (default `~/.pi/agent/agent-memory/`, honors `PI_CODING_AGENT_DIR`) | Global personal memory |

The `user` scope previously hardcoded `~/.pi/agent-memory/`. If that legacy directory exists for an agent and the new location doesn't, it keeps being used — existing memories aren't orphaned.

Memory uses a `MEMORY.md` index file and individual memory files with frontmatter. Agents with write tools get full read-write access. **Read-only agents** (no `write`/`edit` tools) automatically get read-only memory — they can consume memories written by other agents but cannot modify them. This prevents unintended tool escalation.

The `disallowed_tools` field is respected when determining write capability — an agent with `tools: write` + `disallowed_tools: write` correctly gets read-only memory.

## Worktree Isolation

Set `isolation: worktree` to run an agent in a temporary git worktree:

```
Agent({ subagent_type: "refactor", prompt: "...", isolation: "worktree" })
```

The agent gets a full, isolated copy of the repository. On completion:
- **No changes:** worktree is cleaned up automatically
- **Changes made:** changes are committed to a new branch (`pi-agent-<id>`) and returned in the result
- **Agent committed its own work:** the branch is created at the agent's HEAD, preserving its commits (uncommitted leftovers are committed on top first)

The automatic preservation commit uses `--no-verify`, so local pre-commit hooks can't block it — the commit is local-only and never pushed, and pre-push/server-side hooks still apply.

If the worktree cannot be created (not a git repo, no commits, or `git worktree add` fails), the `Agent` tool returns a clear error instead of running unisolated — `isolation: "worktree"` is a strict guarantee, not a hint. Initialize git and commit at least once, or omit `isolation`.
If cleanup cannot be confirmed, the result keeps the worktree path and includes a bounded diagnostic plus recovery commands. Cleanup first tries `git worktree remove --force`; when that fails, pi-subagents only uses direct filesystem removal for a verified package-created temporary path, then prunes and verifies Git's worktree registration. It never recursively removes an arbitrary caller-supplied path automatically. At session shutdown, failed removals are retried deepest-first without blocking siblings or ancestors; late provider continuations are quarantined, and remaining failures are reported as immutable path- and repository-specific diagnostics via `getWorktreeCleanupFailures()`.

The child prompt also states that the temporary worktree is the only writable checkout and names the original base repository as off-limits. This prevents inherited parent instructions from sending the agent back into the shared tree.

## Skill Preloading

Skills can be preloaded by name and injected into the agent's system prompt:

```yaml
---
skills: api-conventions, error-handling
---
```

**Discovery roots** (checked in this order, first match wins):

| Scope | Path | Source |
|---|---|---|
| Project | `<cwd>/.pi/skills/` | Pi-standard |
| Project | `<cwd>/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `$PI_CODING_AGENT_DIR/skills/` (default `~/.pi/agent/skills/`) | Pi-standard |
| User | `~/.agents/skills/` | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User | `~/.pi/skills/` | Legacy (pre-Pi) |

**Per root, a skill named `foo` resolves to the first of:**

- `<root>/foo.md` — flat file at the top level
- `<root>/foo/SKILL.md` — directory skill (top-level)
- `<root>/*/.../foo/SKILL.md` — directory skill, found by recursive descent

Recursion skips dotfile directories and `node_modules`. A directory that itself contains a `SKILL.md` is treated as a single skill — we don't descend into it. Traversal is byte-order sorted for deterministic resolution across filesystems.

**Security:** symlinks are rejected at every layer (root, flat file, skill directory, `SKILL.md` inside a skill directory) — intentional deviation from Pi, which follows symlinks. Skill names with path-traversal characters (`..`, `/`, `\`, spaces, leading dot, >128 chars) are rejected.

## Tool Denylist

Block specific tools from an agent even if extensions provide them:

```yaml
---
tools: read, bash, grep, write
disallowed_tools: write, edit
---
```

This is useful for creating agents that inherit extension tools but should not have write access.

## Architecture

```
src/
  index.ts            # Extension entry: tool/command registration, rendering
  types.ts            # Type definitions (AgentConfig, AgentRecord, etc.)
  default-agents.ts   # Embedded default agent configs (general-purpose, Explore, Plan)
  agent-types.ts      # Unified agent registry (defaults + user), tool name resolution
  agent-runner.ts     # Session creation, execution, graceful max_turns, steer/resume
  agent-manager.ts    # Agent lifecycle, concurrency queue, completion notifications
  cross-extension-rpc.ts # RPC handlers for cross-extension spawn/ping via pi.events
  group-join.ts       # Group join manager: batched completion notifications with timeout
  custom-agents.ts    # Load user-defined agents from .pi/agents/, .agents/agents/, and global agents
  agent-file-toggle.ts # YAML-safe enable/disable, wizard serialization, and agent-file lookup
  memory.ts           # Persistent agent memory (resolve, read, build prompt blocks)
  skill-loader.ts     # Preload skills (Pi-standard + Agent Skills spec layouts)
  output-file.ts      # Streaming output file transcripts for agent sessions
  worktree.ts         # Git worktree isolation (create, cleanup, prune)
  prompts.ts          # Config-driven system prompt builder
  context.ts          # Parent conversation context for inherit_context
  env.ts              # Environment detection (git, platform)
  ui/
    agent-display.ts      # Shared agent formatting: spinner frames, activity, stats, names
    conversation-viewer.ts # Live conversation overlay for viewing agent sessions
    select-item.ts         # Numbered identity-safe selectors for duplicate labels
```

## License

MIT; see `LICENSE` for the complete notice.

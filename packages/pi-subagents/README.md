# @signalridge/pi-subagents

<a id="features"></a>

Managed isolated Pi agent sessions: foreground/background work, steering, Fleet UI, tiers, scheduling and protocol-v4 integration.

## Install

```bash
pi install npm:@signalridge/pi-subagents
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-subagents
```

**Verified host baseline:** Pi 1.4.0. Wildcard peer dependency ranges and retained capability fallbacks do not establish support for older host versions.

## Quick start

```js
Agent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Foreground calls return inline; background calls return an ID and notify on completion. Use `get_subagent_result({ agent_id, wait?, verbose? })` to read results or `steer_subagent({ agent_id, message })` to redirect running/queued work. Cancelling a wait does not stop the child.

## Default agent types

| Type | Tools | Model | Prompt Mode | Description |
|------|-------|-------|-------------|-------------|
| `general-purpose` | all 7 | inherit | `append` (parent twin) | Inherits the parent's full system prompt — same rules, CLAUDE.md, project conventions |
| `Explore` | read, bash, grep, find, ls | tier `low` (shipped model: inherit) | `replace` (standalone) | Fast codebase exploration (read-only) |
| `Plan` | read, bash, grep, find, ls | inherit | `replace` (standalone) | Software architect for implementation planning (read-only) |

The `general-purpose` agent is a **parent twin** — it receives the parent's system prompt plus a sub-agent context bridge, so it follows the same rules the parent does. The parent's skill list, cwd and extension sections are left out: the subagent's own session renders them for itself, so its skills follow its `skills` setting. Explore and Plan use standalone prompts tailored to their read-only roles.

Default agents can be **ejected** (`/agents` → select agent → Eject) to export them as `.md` files for customization, **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`), or **disabled** per-project with `enabled: false` frontmatter.

## Commands

`/agents` opens Agent runs, Agent types, Model tiers, Create new agent and Settings. Fleet handles empty-prompt ↓/←, ↑/↓, Enter to observe and Esc to return. Enter in an observer composes steering; `x` then explicit confirmation stops it. `Ctrl+B` hands off an eligible independent foreground run without restarting it. Workflow controls stay in `/workflows`. See [UI and ownership](docs/reference.md#ui).

## Model tiers

The Agent tool accepts a catalogue `tier`, not `model`/`thinking`. Configure `/agents → Model tiers` and `Settings → Default tier`, or edit global `~/.pi/agent/subagents.json` and project `<cwd>/.pi/subagents.json` (project overrides global; menu writes project only). Example:

```json
{ "agentTiers": { "profiles": { "high": { "model": "provider/reasoning-model", "thinking": "high" } } } }
```

Both profile fields are required; either can be `"inherit"`. Precedence: call tier → agent tier → default tier → `defaultModel` → parent model/thinking. Explore ships with tier `low`; other ordinary types inherit unless configured. Managed untiered calls instead require a named tier, with the shipped `medium` fallback; explicit `none`/`noDefaultTier` rejects them. See [complete tier/configuration reference](docs/reference.md#model-tiers).

## Safety and recovery

- Raw `inherit_context: true` is refused: pass a reviewed, sanitized task summary. Children require a checked parent runtime bridge; absent/incompatible bridges refuse before IDs or provider requests, not a fresh credential/provider runtime.
- Nesting and model scope enforcement are default-off. Nested allowlists grant the listed children's own tools, not the parent's restrictions. Project configuration/resources require trust; extension selection is not an OS sandbox. `pi-background` is excluded from child loading.
- Transcripts default on, independently of native session persistence, memory and worktree commits. `isolation: "worktree"` is strict and can make local preservation commits; failed preservation retains the checkout for manual recovery.
- Subagents never open clarification dialogs for you. Eligible background questions go to the main session, which resolves internal issues itself and asks you only for a real decision—in your language, with background, a recommendation and consequences. Other runs report blockers in their result. Permission confirmations remain human-owned; do not block an answering parent with `get_subagent_result(wait: true)`.
- Overflow pauses automatic wakes: compact or start a new session. Reading a terminal result consumes that attempt's reminder, not stored history. Cold continuation needs exact branch/session/catalog-route proof, not physical-endpoint or cross-profile consent; unsafe history is refused.

See [runtime/notifications](docs/reference.md#parent-runtime-and-notifications), [continuation](docs/reference.md#remembered-ordinary-agent-continuation), [worktrees](docs/reference.md#worktree-isolation), and [clarification limits](docs/reference.md#opt-in-parent-clarification-background-only).

## Upstream and local divergence

Derived from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents), MIT. Local execution, privacy and protocol boundaries remain authoritative; [selective-port provenance](docs/reference.md#upstream-and-local-divergence) records pinned sources.

## License

MIT; see `LICENSE` for the complete notice.

<a id="architecture"></a>
<a id="lint-policy"></a>

## Reference

Source entrypoint: `src/index.ts`; run `bun run check` from the repository root. Detailed contracts and legacy section links:

- <a id="opt-in-parent-clarification-background-only"></a>[Host-routed clarification (background only)](docs/reference.md#opt-in-parent-clarification-background-only)
- <a id="scheduling"></a>[Scheduling](docs/reference.md#scheduling)
- <a id="ui"></a>[UI](docs/reference.md#ui)
- <a id="fleetview"></a>[FleetView](docs/reference.md#fleetview)
- <a id="custom-agents"></a>[Custom agents](docs/reference.md#custom-agents)
- <a id="example-piagentsauditormd"></a>[Example: `.pi/agents/auditor.md`](docs/reference.md#example-piagentsauditormd)
- <a id="frontmatter-fields"></a>[Frontmatter fields](docs/reference.md#frontmatter-fields)
- <a id="nested-subagents"></a>[Nested subagents](docs/reference.md#nested-subagents)
- <a id="child-project-trust"></a>[Child project trust](docs/reference.md#child-project-trust)
- <a id="tool--extension-scoping"></a>[Tool & extension scoping](docs/reference.md#tool--extension-scoping)
- <a id="tools"></a>[Tools](docs/reference.md#tools)
- <a id="agent"></a>[`Agent`](docs/reference.md#agent)
- <a id="remembered-ordinary-agent-continuation"></a>[Remembered ordinary-agent continuation](docs/reference.md#remembered-ordinary-agent-continuation)
- <a id="get_subagent_result"></a>[`get_subagent_result`](docs/reference.md#get_subagent_result)
- <a id="steer_subagent"></a>[`steer_subagent`](docs/reference.md#steer_subagent)
- <a id="answer_subagent_question-main-only"></a>[`answer_subagent_question` (main only)](docs/reference.md#answer_subagent_question-main-only)
- <a id="graceful-max-turns"></a>[Graceful max turns](docs/reference.md#graceful-max-turns)
- <a id="concurrency"></a>[Concurrency](docs/reference.md#concurrency)
- <a id="join-strategies"></a>[Join strategies](docs/reference.md#join-strategies)
- <a id="one-catalogue-including-for-workflows"></a>[One catalogue, including for workflows](docs/reference.md#one-catalogue-including-for-workflows)
- <a id="how-the-host-discovers-tiers"></a>[How the host discovers tiers](docs/reference.md#how-the-host-discovers-tiers)
- <a id="precedence"></a>[Precedence](docs/reference.md#precedence)
- <a id="defaultmodel"></a>[`defaultModel`](docs/reference.md#defaultmodel)
- <a id="editing-tiers"></a>[Editing tiers](docs/reference.md#editing-tiers)
- <a id="refusals"></a>[Refusals](docs/reference.md#refusals)
- <a id="merging-global-and-project-settings"></a>[Merging global and project settings](docs/reference.md#merging-global-and-project-settings)
- <a id="migrating-from-modelthinking"></a>[Migrating from `model:`/`thinking:`](docs/reference.md#migrating-from-modelthinking)
- <a id="model-scope"></a>[Model scope](docs/reference.md#model-scope)
- <a id="persistent-settings"></a>[Persistent settings](docs/reference.md#persistent-settings)
- <a id="events"></a>[Events](docs/reference.md#events)
- <a id="cross-extension-rpc"></a>[Cross-Extension RPC](docs/reference.md#cross-extension-rpc)
- <a id="discovery"></a>[Discovery](docs/reference.md#discovery)
- <a id="ping"></a>[Ping](docs/reference.md#ping)
- <a id="managed-spawn-protocol-v4"></a>[Managed spawn (protocol v4)](docs/reference.md#managed-spawn-protocol-v4)
- <a id="spawn"></a>[Spawn](docs/reference.md#spawn)
- <a id="stop"></a>[Stop](docs/reference.md#stop)
- <a id="optional-workflow-ui-bridge"></a>[Optional workflow UI bridge](docs/reference.md#optional-workflow-ui-bridge)
- <a id="persistent-agent-memory"></a>[Persistent agent memory](docs/reference.md#persistent-agent-memory)
- <a id="worktree-isolation"></a>[Worktree isolation](docs/reference.md#worktree-isolation)
- <a id="skill-preloading"></a>[Skill preloading](docs/reference.md#skill-preloading)
- <a id="tool-denylist"></a>[Tool denylist](docs/reference.md#tool-denylist)

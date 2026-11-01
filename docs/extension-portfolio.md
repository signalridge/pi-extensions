# Extension portfolio

An extension having a distinct owner does not mean every installation benefits
from enabling it. Choose capabilities for a concrete workflow, not a package
count. This guide describes repository capabilities, **not an inventory of what
any particular installation has enabled**.

The portfolio currently contains 31 extensions and two resource-free libraries.
Experimental resources remain explicit opt-ins. Nothing in this guide enables,
removes, installs, or publishes a package.

## Selection rules

1. Keep one main-session continuation controller per task: Goal for an outcome,
   or Ralph for explicit file-backed iterations. Workflows schedules finite child
   work; Subagents executes it. Those are different layers, not interchangeable
   controllers.
2. Keep one authoritative progress record for each purpose. A Todo assertion is
   not a Workflow execution result. Do not copy the same plan into Todo, Ralph
   files and Workflow state merely to make three displays agree.
3. Prefer native commands or existing command-line tools when they meet the
   need. A dedicated extension is justified by a repeatable interaction or a
   lifecycle contract, not by wrapping one shell command.
4. Keep a single footer owner, terminal-title owner, and external lifecycle
   reporter. Editor decorators must preserve the current editor factory.
5. Model-backed convenience features have a request/context cost. Curated
   memory, temporary recaps, linked handoffs and side conversations are separate
   capabilities, not four prerequisites for session continuity.
6. Experimental permissions, compaction and persistence features require their
   own acceptance scope. A successful import is not evidence of live-provider
   compatibility or OS isolation.

See [package boundaries](package-boundaries.md) for enforced ownership and
[compatibility](compatibility.md) for tested host versions and known limits.

## Orchestration and execution

| Extension | Distinct value | Use when / alternative |
| --- | --- | --- |
| `pi-subagents` | Managed child execution, admission, model tiers, concurrency, transcripts and isolation | Use for delegated work. Ordinary single-agent tasks do not need it. |
| `pi-workflows` | Explicit dependency graphs, bounded fan-out, quality steps and journal recovery | Use for repeatable multi-agent topology; a single Agent call does not need a workflow. Requires Subagents. |
| `pi-goal` | Continue until an explicitly stated objective is verified | Use for outcome-driven autonomy; not a second DAG scheduler. Avoid combining main-session continuation with Ralph for the same task. |
| `pi-ralph-wiggum` | Explicit iterative loop with task-file checkpoints | Use when iteration files/pacing are wanted; otherwise prefer one Goal controller or ordinary turns. |
| `pi-plan-mode` | Read-only planning policy and reviewed plan-to-implementation transition, with an optional implementation model | Use for an actual planning boundary, not just to display a checklist. It does not replace a permission policy. Set an implementation model only when a cheaper or faster model should execute the reviewed plan. |
| `pi-ask-user-question` | Structured bounded decisions | Useful when the agent must resolve non-discoverable preferences; ordinary prose is sufficient for trivial questions. |
| `pi-background` | Session-owned local shell jobs, bounded logs and event-driven watches | Opt in for long commands while other work proceeds. Not a durable service manager, remote executor or child-agent runtime. |
| `pi-todo` | Revisioned current-branch checklist with explicit mutations | Opt in for a small manual checklist. Not a project backlog, shared task-claiming service or completion verifier. |

## Session continuity and presentation

| Extension | Distinct value | Use when / alternative |
| --- | --- | --- |
| `pi-input-history` | Persistent prompt search without rewriting submitted text | Use if native editing/history navigation is insufficient; owns prompt history, not session history. |
| `pi-input-prefix` | Themed input editor base and prompt prefix | Presentation only; optional even when History is used. |
| `pi-statusline` | Custom footer presentation and status navigation | Use if its layout/navigation is useful. Native Pi already displays extension status keys. |
| `pi-welcome` | Additive startup summary card | Presentation only. Native startup diagnostics remain authoritative. |
| `pi-tab-status` | Agent state in a terminal tab title, plus opt-in desktop notifications | Useful across multiple terminal tabs; independent of the footer and of Pi's native OSC 7501 status, which tmux does not forward. Avoid another title writer and a second desktop notifier; commit detection is heuristic, not completion evidence. |
| `pi-session-recap` | Temporary orientation after absence or session resumption | Useful for frequent context switching. Adds model requests; native visible transcript may suffice. |
| `pi-sessions` | Human-owned session navigation and reviewed linked handoff | Experimental opt-in when native `/resume`, `/tree` and copying a summary are insufficient. Does not auto-send a destination draft. |
| `pi-recall` | Explicitly curated reusable excerpts | Experimental opt-in for curated memory, not an automatic transcript archive or a replacement for Recap. |
| `pi-btw` | Ephemeral side questions without replacing the main thread, and an opt-in `advisor` tool the model can call for a second opinion | Useful for independent questions; additional model requests and parent-context sharing must be deliberate. Each `advisor` call sends the branch transcript to the configured reviewer model and is billed there. |

## Developer integrations and measurements

| Extension | Distinct value | Use when / alternative |
| --- | --- | --- |
| `pi-lsp` | Structured language-server diagnostics, source actions, navigation (definition, references, hover, symbols) and preview-first rename | Use with supported installed servers when targeted diagnostics, fixes or code navigation help. Servers start per call, so large projects pay their indexing time each call; CLI lint/typecheck remains authoritative. `pi-lens` is the broader, file-editing alternative; never enable both. |
| `pi-github-pr` | Ambient current-branch PR checks, review decisions and comment counts | Useful for persistent PR visibility; no review/comment-body retrieval or agent tool. Use `gh` for detailed review. |
| `pi-files-widget` | In-terminal file browsing/viewing | Optional human interaction; not a replacement for agent read/search tools or an external editor. |
| `pi-code-actions` | Human selection/copy/insertion of assistant code blocks | Optional convenience; snippet execution is a distinct local mutation surface, not just formatting. |
| `pi-stamp` | Transcript timestamp and tool/model metadata | Use for chronology and transcript inspection; not a billing ledger. |
| `pi-usage-extension` | Usage dashboards and exports | Use to inspect persisted tokens/costs. Does not require Analytics or Worktime. |
| `pi-analytics` | Derived operational metrics and experimental analytics persistence | Opt in only when those metrics are needed. Observations are best-effort, not complete request accounting. |
| `pi-worktime` | Current-session active-span tracking | Optional elapsed-work measurement. Not token usage, historical billing or an additive Analytics total. |

## Policy, provider and external integration

| Extension | Distinct value | Use when / alternative |
| --- | --- | --- |
| `pi-agent-guidance` | Select model-family-specific guidance files, and deliver context files from subdirectories the agent works in | Useful when provider guidance differs or when nested directories carry their own `AGENTS.md`; Pi itself loads only the working directory and its ancestors. Nested files load only in trusted projects. |
| `pi-gpt-fast` | Opt-in priority service-tier rewriting for supported OpenAI/Codex requests | Use only when priority latency is worth its provider cost. Extension rewriting does not repair host pricing-accounting limits. |
| `pi-codex-compact` | Provider-specific opaque compaction checkpoints | Experimental, tightly provider-coupled opt-in. Not a portable replacement for native readable summaries. |
| `pi-worktree` | Human-owned Git worktree management and workspace switching | Opt in only for repositories permitting worktrees. Subagents owns its own child isolation; this UI is not its backend. |
| `pi-rules` | Rule files as always-on guidance, an on-demand index and tool-call reminders or blocks | Experimental opt-in. Useful when a team keeps rules beside the code (including Cursor rules) or wants a specific command or edit pattern refused. Not a permission policy; project rules load only in trusted projects. |
| `pi-secrets` | Reversible placeholders for secrets in provider-bound context | Experimental opt-in. Keeps tokens out of what the model provider receives while commands still get real values. Does not stop the agent from using a secret and does not cover the system prompt or compaction requests. |

## Libraries, not selectable capabilities

| Library | Why it is separate |
| --- | --- |
| `pi-subagents-protocol` | Side-effect-free managed wire contracts shared by orchestration and execution. |
| `pi-ui` | Side-effect-free rendering/display/editor-preservation adapters. |

These are ordinary dependencies. Do not add them to Pi's extension resource map.

## What to simplify first

When an installation feels crowded, first disable optional presentation,
unused external/provider integrations and duplicate progress/continuation
surfaces. Do not delete a package merely because it is unnecessary in one
installation. Conversely, a clean ownership table alone is not evidence that a
package is worth its maintenance: retain a concrete use, tests and a bounded
compatibility claim for each capability.

A package whose job another owner now does better is retired rather than kept
for completeness; [retired packages](retired-packages.md) lists each one with
its replacement.

Source changes, package releases, installation updates and resource activation
are separate operations. This repository does not silently update user settings.

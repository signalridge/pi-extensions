# signalridge Pi extensions

A monorepo of [Pi](https://pi.dev) extensions. Every directory under `packages/`
is independently publishable to npm and independently understandable; the
private root is never published and declares no Pi manifest.

Two of them are designed as a pair — start there.

---

## The pair: `pi-subagents` + `pi-workflows`

<a id="who-owns-what"></a>

`pi-workflows` owns orchestration, phases, budgets, journal and resume; `pi-subagents` alone owns model/thinking/tool/skill policy, cwd, isolation, transcripts, retries, stop and live `maxConcurrent` queue capacity. They communicate through the typed protocol-v4 event bus, not source imports. Workflows requires separately loaded Subagents `>=1.9.0`; the peer dependency does not activate it.

A plain JavaScript workflow fans out work:

```js
export const meta = { name: "audit", description: "Scan, then synthesize" };

const findings = await parallel([
  () => agent("Check for cross-package imports", { strength: "low" }),
  () => agent("Check for secrets", { strength: "low" }),
]);

return agent("Synthesize: " + JSON.stringify(findings), { strength: "high" });
```

<a id="why-it-is-split-this-way"></a>

Scripts express effort only as `low`/`medium`/`high` **strengths**, not model/thinking/tier or a separate concurrency policy. `/workflows strength` maps those words to the host's Agent tiers without changing the catalogue; runs read and clamp to the live Subagents pool. See [model routing](packages/pi-workflows/README.md#model-routing).

Full detail lives in each package's README —
[`pi-workflows`](packages/pi-workflows/README.md) for the runtime globals,
resume semantics, and routing table;
[`pi-subagents`](packages/pi-subagents/README.md) for agent types, tiers,
FleetView, and scheduling. The development host target is **Pi 1.5.0**;
the previous full acceptance baseline was Pi 1.4.0.
Host-provided peers use `"*"` for module ownership, not as a claim that every Pi
version is supported. See [compatibility and verification](docs/compatibility.md)
for current host contracts and integration limits.

---

## Install

Packages are installed individually; each package's own `pi.extensions`
manifest controls what Pi loads.

```bash
pi install npm:@signalridge/pi-subagents   # >=1.9.0, protocol v4
pi install npm:@signalridge/pi-workflows
# Optional developer/question tools:
pi install npm:@signalridge/pi-lsp
pi install npm:@signalridge/pi-ask-user-question
```

> **Install any one package from a single source.** An npm copy alongside a
> local checkout of the same package loads both, and the duplicate registers its
> tools twice.

To run from this checkout, load the local directories and skip the installed
catalogue with `-ne`:

```bash
pi -ne -e ./packages/pi-subagents -e ./packages/pi-workflows
```

## Package inventory

### Orchestration and agents

| Package | What it does |
| --- | --- |
| `pi-subagents` | Managed subagent runtime — tiers, workflow-owner Fleet groups, queueing, isolation, scheduling, RPC and host-routed background clarification |
| `pi-workflows` | JavaScript orchestration over those subagents — fan-out, phases, budgets, quality helpers, journal-backed resume |
| `pi-goal` | Autonomous `/goal` completion, with stable, opt-in ordered queues |
| `pi-ralph-wiggum` | Long-running agent loops for iterative development |
| `pi-plan-mode` | Codex-like read-only `/plan` collaboration mode, with an optional implementation model |
| `pi-agent-guidance` | Loads provider-specific context files (`CLAUDE.md`, `CODEX.md`, `GEMINI.md`) based on the current model, and context files from subdirectories the agent works in |
| `pi-ask-user-question` | Structured user-question tool for agents |

### Developer tools

| Package | What it does |
| --- | --- |
| `pi-lsp` | Language-agnostic LSP diagnostics, fixes, navigation and preview-first rename through a shared runner |
| `pi-github-pr` | GitHub pull request review, checks, and comment status |
| `pi-code-actions` | Pick code blocks from recent assistant messages to copy or insert |
| `pi-files-widget` | In-terminal file browser and viewer |
| `pi-btw` | `/btw` side-question command; parent-history sharing is per-question opt-in. Optional `advisor` tool for a second opinion from a configured reviewer model |
| `pi-stamp` | Transcript timestamps, assistant metadata, and tool timing |

### Session and interface

| Package | What it does |
| --- | --- |
| `pi-statusline` | Theme-native statusline |
| `pi-input-prefix` | Theme-aware rounded input editor and prompt token |
| `pi-input-history` | Text-preserving prompt history with grapheme-safe search/highlights and an fzf/atuin-style `Ctrl+R` picker |
| `pi-welcome` | Startup resource and repository summary card |
| `pi-session-recap` | While-you-were-away recap above the editor; raw-history requests require explicit model and consent flags |
| `pi-tab-status` | Terminal tab status indicators and opt-in desktop notifications |
| `pi-usage-extension` | Usage statistics dashboard |

### Host and provider integration

| Package | What it does |
| --- | --- |
| `pi-gpt-fast` | Opt-in OpenAI and Codex priority service tier |

### Opt-in

Publishable, but install them deliberately rather than as part of a default set.

| Package | What it does | Requires |
| --- | --- | --- |
| `pi-worktree` | Safe interactive Git worktree management and workspace switching | A project that allows git worktrees |
| `pi-worktime` | Per-prompt active worktime tracking | — |

### Experimental

Marked `piExtension.lifecycle: experimental`, which keeps them out of a release
unless a changeset names them: `pi-recall`, `pi-codex-compact`, `pi-analytics`,
[`pi-background`](packages/pi-background/README.md) (session-owned background
shell jobs and event-driven log monitors; local macOS/Linux only), and
[`pi-todo`](packages/pi-todo/README.md) (revisioned, branch-local checklists with
explicit manual controls; not a project backlog or execution scheduler),
[`pi-sessions`](packages/pi-sessions/README.md) (human-owned history navigation
and editable linked-session handoff; destination draft only, never auto-send),
[`pi-rules`](packages/pi-rules/README.md) (project and user rule files: always-on
guidance, an on-demand index and tool-call reminders or blocks), and
[`pi-secrets`](packages/pi-secrets/README.md) (reversible placeholders that keep
secrets out of provider-bound context while tools still get real values).

### Libraries

Not Pi extensions. They register no resources, hold no state, and are consumed
as ordinary npm dependencies — never listed in Pi's extension package map.

| Package | What it does |
| --- | --- |
| `pi-subagents-protocol` | Side-effect-free wire contracts for the managed subagent protocol |
| `pi-ui` | Side-effect-free bordered UI, inert display encoding and opt-in public custom-editor preservation adapters |

## Boundaries

Packages communicate through Pi's public APIs and `pi.events`; no extension
imports another extension's source. Each package owns a defined area — the
footer, the input editor, the workflow journal, the subagent queue — and
consumes other packages' state without mutating it.

[`docs/package-boundaries.md`](docs/package-boundaries.md) is the ownership
matrix, including persistence boundaries and the one-declared-range rule for
shared rendering dependencies.

## Development

```bash
bun install --frozen-lockfile
bun run check     # format + lint + typecheck + test
```

Every package owns its own `lint`, `typecheck`, `test`, `format`, and `check`
scripts, runnable individually. Run `bun run check` before committing.

## Release

A change to a published package needs a changeset naming it:

```bash
bun run changeset
bun run changeset:status
```

The Actions workflow opens a Version Packages PR once changes reach `main`;
merging it publishes only the changed packages, via npm Trusted
Publishing/OIDC. See [`docs/releasing.md`](docs/releasing.md) for setup,
bootstrap, rate-limit, and recovery guidance.

The custom packer/publisher is for [new-package bootstrap](docs/releasing.md#new-package-bootstrap) and [partial-release recovery](docs/releasing.md#rate-limits-and-recovery), not normal releases. Bootstrap/token mode requires exactly one selected package. Experimental packages are packed/published only by intentional selection.

See [`LEGAL-NOTICES.md`](LEGAL-NOTICES.md) for retained license handling, and
[`AGENTS.md`](AGENTS.md) for the repository's authoring rules.

## Documentation

- [Package boundaries](docs/package-boundaries.md): runtime ownership, persistence and shared contracts.
- [Extension portfolio](docs/extension-portfolio.md): each capability's value, alternatives and conditional use.
- [Retired packages](docs/retired-packages.md): removed packages, their last versions and replacements.
- [Ecosystem and host review, 2026-11-01](docs/upstream-review-2026-11-01.md): oh-my-pi and ecosystem study, the Pi 1.4.0 baseline move, retirements and ports.
- [Upstream review, 2026-10-23](docs/upstream-review-2026-10-23.md): pinned sources, selective ports and deferred candidates.
- [Compatibility and verification](docs/compatibility.md): tested host, dependency ownership and integration limits.
- [Design decisions](docs/open-decisions.md): isolation, deferred imports, orchestration and resource admission.
- [Task and status navigation](docs/status-navigation.md): shell-job views, status-owner actions and the UI protocol.
- [Release guide](docs/releasing.md): independent versioning, publication and recovery.

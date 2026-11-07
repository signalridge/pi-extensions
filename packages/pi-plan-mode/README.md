# pi-plan-mode — Codex-like plan mode for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-plan-mode)](https://www.npmjs.com/package/@signalridge/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-plan-mode` adds a Codex-like `/plan` collaboration mode to Pi. Plan mode is for read-only exploration, clarifying questions, and a structured implementation-ready plan before any code mutation happens.

Pi core intentionally does not ship a built-in plan mode; this package provides one as an independently installable extension.

> **Read-only risk reduction, not a sandbox.** Mutating built-ins and unsafe shell forms are blocked. Custom/extension tools are disabled by default; enabling one trusts its whole effective implementation. An enabled Agent grants the child's own tool policy, not read-only enforcement. Tests/builds may write caches or execute trusted project hooks; Git/gh inspection can disclose secrets.

## Install

The current tested host is Pi `1.0.4`. Host-provided dependencies use `"*"` peers to identify module ownership, not to guarantee compatibility with every Pi version. See the [compatibility guide](https://github.com/signalridge/pi-extensions/blob/main/docs/compatibility.md) for verification details.

```bash
pi install npm:@signalridge/pi-plan-mode
```

Try without installing permanently:

```bash
pi -e npm:@signalridge/pi-plan-mode
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-plan-mode
```

<a id="features"></a>
<a id="codex-like-behavior"></a>

## Usage

```text
/plan design the migration
/plan finalize
/plan show
/plan implement
# Or save/export instead:
/plan save
/plan export PLAN.md
```

Explore → ask material decisions with `plan_mode_question` → finish with standalone `plan_mode_complete({ plan })` → review. Implement here keeps the conversation; Start fresh and implement transfers only the approved plan to a linked session (normal destination project resources still load). Saved plans are session-local, outside ordinary context, and never silently overwritten.

| Route/state | Behavior |
| --- | --- |
| `/plan` | State-aware TUI/RPC menu; print/JSON reject |
| `/plan start` / `--plan` | Activate without a model message |
| `/plan <prompt>` | Activate then send; only exact start is reserved |
| `/plan tools` | Stage a pre-start selection; cancel changes nothing |
| `/plan show` | Show stored ready/saved/active plan, no model turn |
| `/plan finalize` | Ask for completion or one material question; active mode only |
| `/plan implement` | Implement here directly |
| `/plan save` | Save ready plan and leave Plan mode |
| `/plan export [path]` | Export ready/saved/active plan; ready export exits |
| `/plan exit` / `off` | Discard ready/saved or clear active implementation |

Tools and Settings are locked during Planning/ready state; configure before activation. Required Plan tools remain available, but no late tools enter an active workflow. Completion rejects blank or >50,000-JavaScript-character plans and is model-only; legacy standalone `<proposed_plan>` blocks remain supported. A turn without completion stays active; use finalize to recover.

Export is explicit user-requested mutation, never a model-write escape: default `PLAN.md`, relative to current cwd, absolute or leading @ accepted, missing parents created. Existing files/directories/symlinks are never overwritten. Markdown is exact except one trailing newline. Failed/cancelled exports preserve state; saved/active exports do not exit.

Print/JSON support direct activation, export/save/clear, not tool selectors, show or implementation. Fresh handoff failures leave source recovery available; model/auth drift never silently submits to a different destination. [Complete workflow, editor fallback, provenance and branch recovery](docs/reference.md#usage).

## Settings

Optional `$PI_CODING_AGENT_DIR/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`); read at session start, created only on explicit save. Inactive-menu Settings edits future workflows.

| Key | Omission default |
| --- | --- |
| `thinkingLevel` | `inherit` |
| `defaultPlanTools` | Available safe built-ins; [] means required tools only |
| `implementationPlanRetention` | `keep`; also clear-on-start / clear-after-first-run |
| `defaultPlanExportPath` | `PLAN.md` |
| `toggleShortcut` | None; reload after changing |
| `implementationModel` | None (JSON-only) |
| `implementationThinkingLevel` | `inherit` (JSON-only) |
| `safeSubcommands` | First eight built-in Git validators only (JSON-only) |

Safe shell defaults: git status/log/diff/show/branch/remote/ls-files/grep. Explicit opt-ins: rev-parse/blame/describe/merge-base/ls-tree/cat-file and gh pr view/list, issue view/list (JSON output required). One direct argv-style inspection command only; no shell lists, pipes, substitutions, redirects, expansion, background jobs, installs or mutating flags. Use `git --no-optional-locks status` and `git diff --no-ext-diff --no-textconv` to suppress helpers. [Accepted/rejected examples and validators](docs/reference.md#safe-shell-subcommands).

The reference JSON is an **example**, not omission defaults: its shortcut and shell opt-ins require explicit choice. Saves preserve unknown fields and fail closed on invalid files; legacy plan-mode.json remains readable with warning. Retention is captured at handoff: keep reinjects the exact plan after compaction, clear-on-start keeps only the first request, clear-after-first-run waits through retries/queued continuation to settlement. Model switching applies only to Implement here, never fresh implementation or the configured default; manual/ambiguous selections are not forced back. [Full settings/model/retention contract](docs/reference.md#settings).

<a id="package-layout"></a>

Statuses: plan active / ready / saved / implementing. The entrypoint forwards to internal plan-mode modules.

## License

MIT. See [`LICENSE`](./LICENSE).

## Reference

Detailed contracts and legacy section links:

- <a id="default-plan-tools"></a>[Default Plan tools](docs/reference.md#default-plan-tools)
- <a id="after-implement"></a>[After Implement](docs/reference.md#after-implement)
- <a id="implementation-model"></a>[Implementation model](docs/reference.md#implementation-model)
- <a id="export-destination"></a>[Export destination](docs/reference.md#export-destination)
- <a id="safe-shell-subcommands"></a>[Safe shell subcommands](docs/reference.md#safe-shell-subcommands)
- <a id="thinking-level"></a>[Thinking level](docs/reference.md#thinking-level)

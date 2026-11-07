# signalridge Pi extensions

> [!WARNING]
> **This repository is retired and no longer maintained.** Every `@signalridge/pi-*` package is deprecated on npm and will receive no further releases, fixes or security updates. The repository is archived read-only; existing published versions remain installable but are unsupported. Uninstall them with `pi remove npm:@signalridge/<package>`.

Independent extensions for [Pi](https://pi.dev): subagents, workflows, developer tools and session UI. Each package has its own configuration, README and npm release; the private repository root is development tooling only.

The development host is **Pi 1.5.0**. See [compatibility](docs/compatibility.md) for platform and integration limits.

## Install

Install only the packages you need. For orchestration, load both packages:

```sh
pi install npm:@signalridge/pi-subagents
pi install npm:@signalridge/pi-workflows
```

Other packages install the same way. Experimental packages are opt-in. Do not load an npm copy and a checkout copy of the same extension together.

To try the pair from this checkout without loading installed extensions:

```sh
pi -ne -e ./packages/pi-subagents -e ./packages/pi-workflows
```

## The pair: `pi-subagents` + `pi-workflows`

<a id="who-owns-what"></a>

Subagents owns child execution, model tiers, tools, queueing, isolation and transcripts. Workflows owns orchestration, phases, budgets and journal-backed recovery. They communicate through protocol-v4 events; Workflows requires separately loaded Subagents `>=1.9.0`.

```js
export const meta = { name: "review", description: "Review independent areas" };
const results = await parallel([
  () => agent("Review the API", { strength: "medium" }),
  () => agent("Review the tests", { strength: "medium" }),
]);
return agent("Summarize the findings: " + JSON.stringify(results));
```

<a id="why-it-is-split-this-way"></a>

Scripts choose effort through strengths, not models or a second concurrency policy. See [Workflows](packages/pi-workflows/README.md) and [Subagents](packages/pi-subagents/README.md) for configuration and examples.

## Package inventory

### Orchestration

| Package | Purpose |
| --- | --- |
| [pi-subagents](packages/pi-subagents/README.md) | Child sessions, tiers, queueing, isolation, scheduling and host-routed clarification |
| [pi-workflows](packages/pi-workflows/README.md) | JavaScript orchestration, phases, budgets and recovery |
| [pi-goal](packages/pi-goal/README.md) | Autonomous goals and opt-in ordered queues |
| [pi-ralph-wiggum](packages/pi-ralph-wiggum/README.md) | File-backed iterative development loops |
| [pi-plan-mode](packages/pi-plan-mode/README.md) | Read-only planning and optional implementation handoff |
| [pi-agent-guidance](packages/pi-agent-guidance/README.md) | Provider-specific and subdirectory context files |
| [pi-ask-user-question](packages/pi-ask-user-question/README.md) | Structured user decisions |

### Developer tools

| Package | Purpose |
| --- | --- |
| [pi-lsp](packages/pi-lsp/README.md) | Diagnostics, navigation, fixes and preview-first rename |
| [pi-github-pr](packages/pi-github-pr/README.md) | Pull request review, checks and comments |
| [pi-code-actions](packages/pi-code-actions/README.md) | Copy or insert assistant code blocks |
| [pi-files-widget](packages/pi-files-widget/README.md) | File browser, viewer and annotations |
| [pi-btw](packages/pi-btw/README.md) | Side questions and an optional reviewer model |
| [pi-stamp](packages/pi-stamp/README.md) | Transcript timestamps, metadata and tool timing |

### Session and interface

| Package | Purpose |
| --- | --- |
| [pi-statusline](packages/pi-statusline/README.md) | Footer and status inspection |
| [pi-input-prefix](packages/pi-input-prefix/README.md) | Themed input editor |
| [pi-input-history](packages/pi-input-history/README.md) | Prompt history and search |
| [pi-welcome](packages/pi-welcome/README.md) | Startup summary |
| [pi-session-recap](packages/pi-session-recap/README.md) | While-away recap; raw-history requests require explicit consent |
| [pi-tab-status](packages/pi-tab-status/README.md) | Terminal title and opt-in notifications |
| [pi-usage-extension](packages/pi-usage-extension/README.md) | Usage dashboard |
| [pi-worktime](packages/pi-worktime/README.md) | Opt-in active worktime tracking |
| [pi-worktree](packages/pi-worktree/README.md) | Opt-in Git worktree management; requires a project that permits worktrees |
| [pi-gpt-fast](packages/pi-gpt-fast/README.md) | Opt-in OpenAI/Codex priority service tier |

### Experimental

Install these deliberately; review each package's requirements and limits first.

| Package | Purpose |
| --- | --- |
| [pi-analytics](packages/pi-analytics/README.md) | Derived usage analytics |
| [pi-background](packages/pi-background/README.md) | Session-owned local shell jobs and log monitors |
| [pi-codex-compact](packages/pi-codex-compact/README.md) | Codex checkpoint-aware compaction |
| [pi-recall](packages/pi-recall/README.md) | Session recall |
| [pi-rules](packages/pi-rules/README.md) | Rule discovery, reminders and tool-call blocks |
| [pi-secrets](packages/pi-secrets/README.md) | Request-projection secret placeholders |
| [pi-sessions](packages/pi-sessions/README.md) | Human-owned history navigation and editable handoff |
| [pi-todo](packages/pi-todo/README.md) | Revisioned session checklists, not a project scheduler |

### Libraries

These are ordinary dependencies, not extensions to enable in Pi.

| Package | Purpose |
| --- | --- |
| [pi-subagents-protocol](packages/pi-subagents-protocol/README.md) | Side-effect-free managed-agent wire contracts |
| [pi-ui](packages/pi-ui/README.md) | Shared UI framing and inert display encoding |

## Development

Use Node 24 and Bun 1.3.14:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

<a id="boundaries"></a>

See [CONTRIBUTING.md](CONTRIBUTING.md) for package ownership, focused checks and contribution rules. Extensions use Pi APIs and validated events, never another extension's source or settings.

## Documentation

- Package READMEs: installation, commands and package-local references.
- [Compatibility](docs/compatibility.md): host requirements and verification limits.
- [Releasing](docs/releasing.md): independent Changesets versions and Trusted Publishing.
- [Retired packages](docs/retired-packages.md): migration paths.
- [License](LICENSE) and [third-party notices](LEGAL-NOTICES.md).

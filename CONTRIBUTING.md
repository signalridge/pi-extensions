# Contributing

## Setup and checks

Use **Node 24**, **Bun 1.3.14** and the committed lockfile. Pi development dependencies target **1.5.0**.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Every package also owns independently runnable scripts:

```sh
bun run --cwd packages/pi-subagents check
bun run --cwd packages/pi-subagents test -- test/supervisor.test.ts
```

Use focused checks while editing, then run the full root check before committing. It covers package configuration, dependency boundaries, lint, types, package and integration tests, release tooling, native schemas, packaged loading, tarballs and secret scanning. See [compatibility](docs/compatibility.md) for optional CLI tests and their limits.

## Package structure

- Each `packages/<name>` directory is independently understandable and publishable. Keep entrypoints thin and domain logic in named modules.
- A package README owns onboarding; an optional package-local `docs/reference.md` owns detailed contracts. Include linked references in its manifest's `files`.
- The private root has no Pi manifest. Extension manifests are authoritative; experimental extensions stay explicitly opt-in.
- Extensions communicate through public Pi APIs and validated `pi.events` payloads, not another extension's source or settings schema.
- Extract shared code only into intentional libraries. `pi-ui` and `pi-subagents-protocol` register no resources, read no settings and perform no import-time work.

## Runtime boundaries

| Owner | Responsibility |
| --- | --- |
| Subagents | Child sessions, execution policy, tiers, queue, tools, isolation, transcripts and exact-agent operations |
| Workflows | Orchestration, helper lifetimes, budgets, durable workflow facts and workflow overview |
| Goal / Ralph / Plan | Their own continuation, iteration or planning state; not another package's queue or model catalogue |
| UI extensions | Their declared surface and status keys; renderers consume producer state without overwriting it |
| Background | Session-owned local process groups, logs and monitors; not remote execution or managed-child continuation |

Prefer one main-session continuation controller per task. Combining controllers does not combine their budgets or ownership. Workflow scripts express strengths; Subagents remains the model/thinking authority. A helper returning does not prove accepted child operations are quiescent.

- Use `ctx.mode === "tui"` for custom terminal components and `ctx.hasUI` for supported dialogs. Defer imports only to keep a TUI-only dependency out of headless paths, after checking the mode; this is not permission for arbitrary dynamic imports or private host patches.
- Scope asynchronous work to its session, branch and exact attempt. After replacement, use the fresh destination context; never restore stale editor or session state after an await.
- Suppress automatic model wakes while context overflow remains unrecovered. Only compaction or a later successful response proves recovery; aborts and transient errors do not. Deliver content without triggering another oversized request.
- Keep persistence schemas with their owner. Validate peer facts instead of interpreting another package's private journal. Uncertain writes must not become successful memory-only commits; terminal success requires owned work and durable finalization to settle.
- Keep native session history authoritative. Navigation and handoff must preserve user data and newer drafts; they are not permission to auto-send, switch models or restore credentials.
- Admission to a tool or UI surface is not approval. Enforce permission policy on actual calls, including nested calls; clarification cannot override a human rejection.

### Status actions and policy ordering

The optional `pi-ui:status-actions:v1:query` / `open` bus is UI navigation only, not execution or process control. Validate exact own data fields and current session/branch/surface identity at discovery, admission and mount. An `accepted` reply acknowledges admission, not successful rendering. Conflicting status owners are not selectable, and consumers must dispose their selector before opening the owner's view. The [producer](packages/pi-background/src/status-actions.ts) and [consumer](packages/pi-statusline/src/status-actions.ts) define the bounded wire contract.

When composing these hooks:

- Load Subagents before Secrets to cover request-local subagent questions in `context_with_system`.
- Load Secrets before rules/permission handlers that must inspect restored tool arguments.
- Load Rules before a permission handler that prompts, so a later rule block does not follow an unnecessary approval.

Rules are not a permission system; secret projection is not universal redaction. Follow the respective package contracts. Background launch tools need permission coverage separate from `bash`; managed children do not load the asynchronous Background owner.

## Shared dependencies

Host-provided modules use literal `"*"` peers, never bundled runtime copies. The wildcard denotes module ownership, not support for every host version. Use the host's canonical TypeBox identity; current development pins are authoritative.

Shared third-party runtime/peer dependencies must declare the same range string wherever at least two packages use them. Overlapping but different ranges do not qualify. Development toolchains may differ: Subagents deliberately runs its own lint/type/test configuration. `bun run check:shared-deps` enforces the runtime rule.

## Documentation and changes

Keep documentation about current use and maintenance. Put one-off audits, research notes, acceptance reports and incident timelines in issues or PR discussions, not tracked Markdown. Runtime skills, templates and test fixtures are functional assets, not disposable documentation.

Preserve upstream licenses and necessary attribution in package notices and [LEGAL-NOTICES.md](LEGAL-NOTICES.md). Do not publish personal provisioning or configuration details. Repository-specific authoring rules are in [AGENTS.md](AGENTS.md).

A change to published package files needs a Changeset naming that package. Versions are independent: major for compiled/protocol breakage, minor for other behavior changes, patch for fixes or shipped documentation. Repository-only tooling, tests and root documentation do not require package releases.

Use the normal [release workflow](docs/releasing.md). Do not hand-edit released versions/changelogs or run `npm publish` from a checkout.

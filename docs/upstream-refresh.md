# Upstream refresh and Pi compatibility

Snapshot: 2026-09-13.

## Synced upstreams

The reference repositories were fetched or cloned locally and reviewed at these
remote heads:

| Project | Ref | Main finding |
| --- | --- | --- |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents/commit/e955e29c51b7a6cce37e1108cd2d6c57a77e151c) | `e955e29` | v0.19 adds script-based workflows, structured agent output, gates, and safer concurrency; the current unreleased fix recognises a lowercase `workflow` tool. |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions/commit/ccf6e651e53721775b2c9693b4413deff7d45df2) | `ccf6e65` | The most useful current references are the LSP lifecycle work, Plan fresh-session handoff, TUI capability alignment, and provider usage integrations. |
| [ouzhenkun/pi-input-history](https://github.com/ouzhenkun/pi-input-history/commit/bec682607f678cdc13f06c17af313ec38e9510b4) | `bec6826` / v1.1.0 | Adds configurable shortcuts, wrapped previews, adaptive viewports, scrolling, and minimal-span highlighting. |
| [earendil-works/pi-mono](https://github.com/earendil-works/pi-mono/commit/71dca871bc80b6bc97be37f0ca3189399d651fff) | `71dca87` | `main` still reports Pi package version 0.85.1, but its changelog contains unreleased API and behavior changes. |

The upstream checkouts are reference material only; local divergence remains in
this repository rather than being overwritten by upstream files.

## Released Pi compatibility

The latest released npm versions are all **0.85.1**:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`

Evidence: [npm registry metadata](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent)
and the [v0.85.1 release](https://github.com/earendil-works/pi/releases/tag/v0.85.1).

This workspace contains 29 packages: 27 extensions and two libraries. 28
packages consume Pi packages, and all of their Pi peers currently declare
`^0.84.0 || ^0.85.0`; the root development pins are exact `0.85.1` versions.
The package manifests and the complete compatibility matrix pass against that
released host. Pi 0.86+ and the unreleased `pi-mono` `main` branch are not
claimed by the peer ranges.

The latest audit fixed these released-host issues:

- `pi-subagents` now passes validated `beforeToolCall` arguments through
  `context.args`, which is the Pi 0.85.1 contract, so `ask_tools` approvals show
  the command being approved.
- `pi-btw` now trusts Pi's `ok` authentication result, including ambient AWS
  credentials, and applies an auth-resolved endpoint to direct side-thread
  requests.
- `pi-session-recap` applies an auth-resolved endpoint before using the
  compatibility stream functions.
- `pi-worktree` normalizes equivalent session cwd spellings before verification,
  covering Windows path forms without weakening symlink checks.
- `pi-subagents` raises its `nanoid` floor to `^5.1.16`, matching the current
  upstream security baseline.

## High-value references for future work

These are deliberately not wholesale sync candidates. The local packages have
stable public contracts, different persistence formats, or a deliberate split
between responsibilities.

| Priority | Upstream reference | Local package | Recommendation |
| --- | --- | --- | --- |
| High | `narumiruna/pi-extensions` commits `756e1e29`, `43cd4738`, `c23e6047` | `pi-lsp` | Port URI canonicalization, process-exit waiting, and session-owned cancellation; retain the local route and diagnostic ownership model. |
| High | `narumiruna/pi-extensions` commits `ee07eb8c`, `c0fe03ed`, `f24a5b00` | `pi-btw` | Add provider-scoped OpenCode session headers, terminal input draining on Ctrl+C, and jump-to-latest behavior. The auth endpoint part is already applied locally. |
| High | `narumiruna/pi-extensions` commits `71179edc`, `d7f08848` | `pi-github-pr` | Move startup refresh off the `session_start` critical path and use one cancellation/ownership controller for GitHub refreshes. |
| High | `narumiruna/pi-extensions` commits `0ef037de`, `b7453303`, `7c9a062f` | `pi-plan-mode` | Consider selectable/persistent fresh implementation model and thinking defaults plus a generation-fenced settled handoff. Do not replace the local plan state machine. |
| High | `narumiruna/pi-extensions` commits `ac745429`, `27e72def`, `455e8054` | `pi-codex-compact` | Use the Responses Compact route abstraction and retained-message validation while preserving the local checkpoint marker and recovery protocol. |
| Medium | `narumiruna/pi-extensions` commits `21f96d05`, `aca0c7d3` | `pi-goal` | Evaluate recoverable provider-retry waiting and Markdown completion rendering separately from the local ordered-queue semantics. |
| Medium | `narumiruna/pi-extensions` commits `b87641b7`, `36a5ad51` | `pi-statusline` | Add native UI-waiting state and terminal true-color capability handling; keep the local incremental usage/runtime refresh design. |
| Medium | `ouzhenkun/pi-input-history` commits `b26ddef`, `8ebd9f0` | `pi-input-history` | Port shortcut configuration and minimal-span match selection only. The local two-pane popup already supersedes the upstream single-preview layout. |
| Medium | `narumiruna/pi-extensions` commit `c7984977` | `pi-stamp` | Consider opt-in cost-since-user metadata after defining deduplication boundaries for retries, tool usage, and resumed branches. |
| Reference only | `tintinweb/pi-subagents` v0.19 | `pi-subagents` / `pi-workflows` | Study structured results, gates, worker isolation, and workflow recovery. Do not merge the integrated Workflow tool: this repository intentionally keeps orchestration in `pi-workflows` with its own protocol and journal. |

The latest Narumi repository also has useful standalone examples such as
`pi-herdr`, `pi-tui-kit`, `pi-usage`, `pi-sync`, `pi-todo`, and `pi-tool`.
They are references for lifecycle ownership, bounded TUI interactions, provider
integration, and publishable package boundaries rather than direct dependencies
for the existing extensions.

## Verification

The final workspace run was:

```text
bun run check  # passed
```

That check covered all 29 manifests, strict lint, all package typechecks and
package tests, release/configuration tests, Pi loader smoke tests, tarball
validation, and the secret scan. The unreleased Pi `main` changes are tracked
separately and should only widen peer ranges after a tagged npm release and a
new full matrix run.

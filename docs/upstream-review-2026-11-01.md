# Ecosystem and host review — 2026-11-01

## Scope and method

Reviewed the repository at `f25160c` against three sources:

1. **oh-my-pi** (`can1357/oh-my-pi`, MIT), a batteries-included fork of Pi,
   studied at [`1f23be9b`](https://github.com/can1357/oh-my-pi/commit/1f23be9b8986237afb78aa15e91bbb57d98ce784)
   (v18.14.1). Every capability Pi does not have was inventoried and checked
   against Pi's public extension types, agent session and agent loop — not its
   marketing — for whether an ordinary extension can provide it.
2. **The Pi host** from the previous baseline 1.0.4 through 1.4.0 and the
   unreleased main branch at [`25426f72`](https://github.com/earendil-works/pi/commit/25426f72ae04a306f1e08de09583b4e89503b9e7):
   every changelog entry, the extension types, and the built-in extensions.
3. **The extension ecosystem**: the npm `pi-package` keyword (13,086 packages;
   the search API pages through 4,500), the top 400 of the pi.dev gallery by
   downloads, weekly npm downloads for about a hundred candidates, GitHub stars
   and default-branch activity, and source reads of fifteen candidates. Some
   download counts are implausible (for example a package with ten stars and
   460K weekly downloads) and were not used as evidence on their own.

The forked upstreams recorded in [the 2026-10-23 review](upstream-review-2026-10-23.md)
were compared from their checked refs:

| Source | Checked commit | Result |
| --- | --- | --- |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | [`00de0cd9`](https://github.com/tintinweb/pi-subagents/commit/00de0cd9) | 9 commits; 5 ported |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | [`486f5c55`](https://github.com/narumiruna/pi-extensions/commit/486f5c55) | 113 non-merge commits; 3 ported |
| [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions) | [`0c364147`](https://github.com/tmustier/pi-extensions/commit/0c364147) | 51 commits; 7 ported |
| [ouzhenkun/pi-input-history](https://github.com/ouzhenkun/pi-input-history) | [`8591664e`](https://github.com/ouzhenkun/pi-input-history/commit/8591664e) | packaging only |
| [tomsej/pi-ext](https://github.com/tomsej/pi-ext) | [`e132c44b`](https://github.com/tomsej/pi-ext/commit/e132c44b) | unchanged |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | [`a37a2885`](https://github.com/nicobailon/pi-subagents/commit/a37a2885) | design reference; 1 hardening idea ported |

## Added

oh-my-pi's headline capabilities were checked against Pi's hooks before porting.
Pi has no "abort this stream and retry" primitive: `ctx.abort()` behaves exactly
like the user pressing Esc. omp's own bundled rules never interrupt either, so the
enforcement that matters — at `tool_call` — ports cleanly; the rest was scoped
to what an ordinary extension can do.

| Package | Capability | Source |
| --- | --- | --- |
| `pi-rules` (new, experimental) | Rule files from `.pi/rules`, `.agents/rules`, Cursor `.cursor/rules/*.mdc` and the agent directory: always-on rules in one byte-stable prompt section, description-only rules in an index with `read_rule`, path-glob offers, and `edit`/`write`/`bash` conditions that remind or block at `tool_call`, with a branch-persisted repeat policy. Project rules load only in trusted projects. | oh-my-pi rulebook and TTSR, without mid-stream interruption |
| `pi-secrets` (new, experimental) | Secret-looking environment values, URL passwords, vendor-prefixed tokens and configured literals become deterministic placeholders in provider-bound context; tool-call arguments get real values back. Stored entries never change. | oh-my-pi secret obfuscation |
| `pi-lsp` | Definition, references, hover, document/workspace symbols and preview-first rename, routed to servers that advertise each capability; Biome's literal code actions; Windows command shims. | oh-my-pi LSP tools; narumiruna `246a2cb9`, `cda5d36e`, `90bafa06` |
| `pi-btw` | Opt-in `advisor` tool: the model asks a configured reviewer model for a second opinion on the current branch, without tools and only in UI sessions. | `@juicesharp/rpiv-advisor` |
| `pi-agent-guidance` | Context files from subdirectories the agent reads or edits, delivered once per branch with size caps, only in trusted projects. | `pi-subdir-context` |
| `pi-tab-status` | Opt-in desktop notifications on settle and stall (OSC 777/9/99, tmux passthrough), silent in child sessions and for aborted runs. | `pi-notify`, Pi's notify example |
| `pi-plan-mode` | Optional implementation model and thinking level for the reviewed plan, restored on exit only if unchanged. | oh-my-pi plan-yolo/prewalk idea |

## Host baseline: Pi 1.4.0

The development baseline moved from Pi 1.0.4 to **1.4.0** after a full
acceptance run. [Compatibility](compatibility.md) lists the host changes
extensions must now account for. The move was not cosmetic: typechecking and the
re-enabled host-gated suites found production regressions that users running a
current Pi were already hitting.

| Package | Symptom on Pi 1.2+ / 1.3+ | Cause |
| --- | --- | --- |
| `pi-workflows` | The workflow keyword and standing `/effort high\|ultra` no longer authorized the `workflow` tool; the hidden guidance was silently dropped. | The session counts as busy while its own run starts, so an idle check inside `before_agent_start` always failed. |
| `pi-goal` | A subagent-completion wake counted as a manual goal run. | `before_agent_start` now also fires for idle custom-message runs. |
| `pi-analytics` | Extension-started runs were labelled `unknown`. | Same. |
| `pi-subagents` | A message typed while a subagent-question wake started aborted the wake and lost or stranded the message; `scopeModels` refused models Pi's own scope allows. | Busy-while-starting steer delivery; Pi 1.4 `enabledModels` resolution changes. |
| `pi-sessions` | Each `/sessions` or `/handoff` dialog left an invisible overlay (fullscreen scrollbar stopped working); literal cursor markers appeared in its editors. | Overlay close removes only its own overlay; pi-tui draws the cursor between zero-width markers. |
| `pi-input-prefix` | With the cursor on the leading `!`, the shell bang was not detached into the prompt token. | Same cursor markers. |
| `pi-code-actions` | A dialog disposed by `/reload` never settled its owner. | `/reload` disposes open dialogs without closing them. |

Every other failure was test coupling — pinned version strings, 1.0.4-only
private host internals, or suites skipped unless the host was 1.0.4 — and was
requalified on 1.4.0 without weakening what the test protects. Several suites
had been silently skipped since the host moved; they now run.

## Retired

| Package | Why | Replacement |
| --- | --- | --- |
| `pi-herdr-state` | herdr ships and versions its own Pi integration together with its socket protocol; a second implementation can only lag it. | `herdr integration install pi` |
| `pi-approvals`, `pi-approval-core` | Per-operation review worked only with a certification flag and a live adapter for every noncanonical mutation tool, so it denied most real tool loadouts and stayed experimental; it required cooperation code in `pi-background` and `pi-subagents`. | A permission extension such as `@gotgenes/pi-permission-system`, or a command blocker such as `cc-safety-net` |

See [retired packages](retired-packages.md) for last versions and migration.

## Upstream fixes ported

| Package | Change | Upstream |
| --- | --- | --- |
| `pi-codex-compact` | Deduplicate a repeated compaction item whose keys arrive in another order instead of rejecting a valid compaction. | narumiruna [`6b89b6ab`](https://github.com/narumiruna/pi-extensions/commit/6b89b6ab) |
| `pi-session-recap` | Render only cleanly stopped recaps; report failures through the UI, not the console; recap sessions reopened from the command line; do not let session usage clamp the recap to one token. | tmustier [`1fcf4144`](https://github.com/tmustier/pi-extensions/commit/1fcf4144), [`0c9b1165`](https://github.com/tmustier/pi-extensions/commit/0c9b1165), [`19ccef78`](https://github.com/tmustier/pi-extensions/commit/19ccef78), [`b937a470`](https://github.com/tmustier/pi-extensions/commit/b937a470) |
| `pi-usage-extension` | Read the session directory Pi actually uses; collapse Windows home directories in project labels. | tmustier [`cf65f962`](https://github.com/tmustier/pi-extensions/commit/cf65f962), [`e38e1cf3`](https://github.com/tmustier/pi-extensions/commit/e38e1cf3), [`91a28802`](https://github.com/tmustier/pi-extensions/commit/91a28802) |
| `pi-files-widget` | Suggest Homebrew only on macOS and name only the missing tools. | tmustier [`ec06085e`](https://github.com/tmustier/pi-extensions/commit/ec06085e) |
| `pi-subagents` | Inherit the parent thinking level; answer `get_subagent_result` from the saved record; keep the parent's skills and cwd out of append-mode prompts; accept Claude Code tool names and `disallowedTools`; mention Explore only when spawnable; skip non-regular memory/skill/agent files. | tintinweb [`4fe1877f`](https://github.com/tintinweb/pi-subagents/commit/4fe1877f), [`00de0cd9`](https://github.com/tintinweb/pi-subagents/commit/00de0cd9), [`15464f3b`](https://github.com/tintinweb/pi-subagents/commit/15464f3b), [`5c81f518`](https://github.com/tintinweb/pi-subagents/commit/5c81f518), [`f42173ff`](https://github.com/tintinweb/pi-subagents/commit/f42173ff); nicobailon [`b09eb5e8`](https://github.com/nicobailon/pi-subagents/commit/b09eb5e8) |

## Compaction and long-session reliability

A second pass analyzed how the packages behave in long real sessions: tool-call
error rates, stop reasons, compaction outcomes and the run sequences around
context overflows. Live Remote V2 compactions with synthetic history confirmed
that `pi-codex-compact` 1.10's staged deadlines and bounded folds complete a
~725K-token compaction in under half a minute; earlier releases' five-minute
total deadline could not. Three defects remained and are fixed:

| Package | Defect | Change |
| --- | --- | --- |
| `pi-codex-compact` | Once the boundary was an opaque checkpoint, every post-authorization remote failure cancelled compaction. Transient provider failures (overload, 5xx, stream errors) then repeated each turn until the context passed the model window. | **Layered fallback** (default, setting `layeredFallback`): keep the previous opaque history and append one readable summary of only the newly dropped messages (checkpoint format v2). It cancels as before when that summary also fails and for malformed, incompatible, unconsented, drifted or diverged state. |
| `pi-subagents`, `pi-background`, `pi-workflows`, `pi-goal` | After an unrecovered context overflow, each completion notice, background wake, workflow delivery or goal continuation started another run that could only overflow again, billed for the full context each time. | Deliver without starting a turn while an overflow has no later successful response or compaction; aborts and transient provider errors do not establish recovery. One notice per episode; normal waking after recovery. |
| `pi-subagents` | The running/queued `get_subagent_result` reply said "check back later", contradicting the tool guidance not to poll; a large share of result calls returned a still-running status. | The reply now says completion is notified and to use `wait: true` only when blocked. |

Also in this pass: `pi-subagents` injects pending parent questions through
`context_with_system`, which keeps Pi's cached system layout stable (nicobailon
[`f45abdb9`](https://github.com/nicobailon/pi-subagents/commit/f45abdb9));
`pi-usage-extension` gains a This Month period computed on the local civil
calendar (tmustier [`3de53e29`](https://github.com/tmustier/pi-extensions/commit/3de53e29));
`pi-code-actions` copies through Pi's `copyToClipboard`, gaining OSC 52 for
remote sessions, Termux and WSL; `pi-tab-status` uses `agent_settled.aborted` so
a cancelled run is neither shown as finished nor notified.

Final review added regression coverage for live-state changes during layered
summaries and UI cleanup, transient errors after overflow, cancelled wake
follow-ups, asynchronous compaction release, concurrent secondary-file rename
edits, Unicode identifier boundaries, model-selection ownership, learned secret
values and fabricated placeholders, guidance content reversions, bounded rule
records, advisor credential cancellation, and stacked-dialog disposal. The
real-CLI shortcut harness compares stable job identity rather than elapsed-time
text, avoiding a false failure at a clock boundary.

## Investigated, not added

| Candidate | Decision |
| --- | --- |
| omp mid-stream rule interruption (TTSR abort and retry) | Not portable: `ctx.abort()` is the user's Esc (queued messages return to the editor, retries and compaction are cancelled) and Pi has no hook to hide the aborted card or continue the same turn. omp's own bundled rules never interrupt either; the tool-call enforcement that matters is in `pi-rules`. |
| omp always-on advisor/watchdog | Deferred: one extra second-provider request per run and continuation ownership conflicts with Goal and Ralph. The on-demand advisor tool covers the second-opinion need. |
| omp checkpoint/rewind context tools; `pi-workspace-history` file snapshots | Deferred: a rewind drops evidence later turns may need, and file snapshots block the first tool call on large repositories and restore files outside any review path. Worth a dedicated design. |
| omp collab, voice, DAP debugger, Python/JS kernels, hashline edits | Not portable as extensions (native code, relay service, built-in tool overrides that conflict with other owners) or out of proportion to their use here. |
| `pi-lens` (28K/week) | Install upstream if wanted; it formats and edits files and ships native dependencies. `pi-lsp` stays the narrow option. Never enable both. |
| `@plannotator/pi-extension` | Install upstream if wanted, instead of `pi-plan-mode`, never both. |
| `cc-safety-net`, `@gotgenes/pi-permission-system` | Install upstream; command blockers and permission policies, not owned here. |
| `@narumitw/pi-notify` | Install upstream for remote push providers; it stores credentials. |
| `pi-interactive-shell`, `pi-rewind-hook` | Still no LICENSE file in the source tree; not copied. |
| `pi-sandbox` | Still declares a Pi range that excludes 1.x. |
| `pi-agent-browser-native`, `pi-diff-review` | Unchanged since the previous review. |

## Follow-ups

- Pi's next release injects `keyText()`/`keyHint()` into renderer options;
  `pi-welcome` can adopt it then with feature detection.
- Pi's next release shows extension changelogs after updates. Every package's
  `CHANGELOG.md` is already compatible; Changesets dependency lines will be
  visible to users.
- `pi-lsp` diagnostics after every edit need session-owned warm servers; the
  per-call lifecycle stays until that is designed.

## Validation

`bun run check` passes on Pi 1.4.0 across 33 packages (31 extensions, two
libraries): configuration, boundary, shared-range, version and Changeset checks;
lint, TypeScript and tests for every package (484 test files); integration,
release and configuration tests; loader smoke that activates each of the 31
extension tarballs independently, the Subagents/Workflows pair, and the 23
stable extensions together; tarball validation; and secret scanning. Each new or
changed capability has a test that fails without it.

Offline SDK/faux-provider, fixture and rendered-component tests do not establish
live providers, physical terminals or every language server. `pi-lsp`'s new
TypeScript navigation default was not run against a real
`typescript-language-server`; its navigation and rename were run against real
gopls.

# pi-statusline — quiet text footer for Pi

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-statusline` is a theme-native footer for the [Pi coding agent](https://pi.dev). Its default Signalridge profile is a restrained, text-first two-line hierarchy: model and thinking state, workspace and branch metadata, active work, and context usage. Context is placed at the right edge when the terminal is wide enough.

Typical output is similar to:

```text
gpt-5.6-sol · think max · main                         ctx 42%
```

The default uses one dim `·` separator and muted metadata, reserving accent/warning/error colors for current or abnormal state. No persistent icons, emoji, powerline blocks or hard-coded backgrounds.

## Selective upstream compatibility

Terminal-capability handling is selectively ported from [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions/commit/36a5ad5149d890b03803c9fa971b875656dcf4e4). Optional powerline palettes and separators follow Pi's live truecolor capability, falling back to ANSI 256 colors. Theme-native colors remain owned by Pi. PR context accepts both linked and strict plain `PR #123:` statuses, displaying each PR once. Local quiet defaults, sanitation, width fitting, settings and lifecycle safeguards remain unchanged.

## Install

```bash
pi install npm:@signalridge/pi-statusline
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-statusline
```

The package is publishable and stable.

## Profiles and settings

The canonical settings file is:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-statusline.json
```

When it exists, the canonical file always wins. Older installations using `pi-statusline-settings.json` remain readable and are never rewritten or deleted. If only the legacy file exists, statusline reads it and writes future changes to the canonical filename.

With neither file present, `PI_STATUSLINE_PRESET=classic` selects the Signalridge default (as does an unset or unknown value):

```bash
PI_STATUSLINE_PRESET=classic pi
```

`PI_STATUSLINE_PRESET=tokyo-night` remains an explicit opt-in to the richer powerline renderer. Existing canonical or legacy JSON settings always take precedence over the environment. The settings editor and `/statusline` menu can choose the optional named palettes, information profiles, custom layout, and foreground/background palette values.

Settings writes validate recognized fields, preserve unknown fields, publish through a same-directory temporary file and atomic rename, and fail closed on malformed input or publication errors. Existing files are not replaced when a save fails.

Useful commands:

```text
/statusline          open the interactive menu in TUI mode
/statusline inspect  inspect current extension statuses (also Ctrl+Alt+S)
/statusline settings edit and apply the canonical JSON document
/statusline status   show the effective source, cost origin, and diagnostics
/statusline help     show configuration help
```

## Inspect extension statuses

Use **Inspect extension statuses** in `/statusline`, `/statusline inspect`, or **Ctrl+Alt+S** to open a compact, read-only list of the current extension statuses. Arrows and Pi's configured selection bindings navigate; Enter opens the selected owner's detail view when that extension cooperates. Other statuses show bounded, sanitized, wrapped plain text inside the inspector. Esc closes without changing the editor draft. Inspection does not change status visibility or settings, execute slash commands, or send model messages. `/statusline status` reports settings and the usage snapshot's cost origin.

The shortcut opens only when the host's public focus capabilities identify an editor without autocomplete and no overlay is active. Hosts without these capabilities fail closed; use the slash command instead. The footer itself is unchanged. Lists and pending requests retire with their footer/session owner; removed rows lose selection rather than activating a neighbor.

### Optional owner-detail protocol (v1)

Statusline is a consumer, not a command dispatcher. Providers implement these `pi.events` channels locally; no cross-package source imports are needed. The exported wire types and consumer helpers live in `src/status-actions.ts`.

- Query channel: `pi-ui:status-actions:v1:query`, request `{version:1,requestId,sessionId}`.
- Reply channel: `${channel}:reply:${requestId}`, reply `{success:true,data:{version:1,providerId,surfaceId,sessionId,entries:[{statusKey,actionId,label}]}}`.
- Open channel: `pi-ui:status-actions:v1:open`, request `{version:1,requestId,providerId,surfaceId,sessionId,actionId}`.
- Open reply: `{success:true,data:{accepted:true}}` on its request's reply channel means **admission**, not completion. Providers reply on admission, then asynchronously open their owner-local view.

Providers answer queries synchronously only for their active TUI session/branch, and handle opens only for their matching, unique owned surface; mismatches are ignored. Identifiers are nonempty strings of at most 128 characters; labels/status keys are at most 512. Snapshots use exact own data fields (no extra, inherited, or accessor fields), with unique status keys/action IDs. Discovery collects for 50 ms, at most 32 providers/64 entries in total. Exact repeated snapshots deduplicate; conflicting snapshots/surfaces suppress that provider, and multiply claimed status keys have no action. Aggregate overflow fails closed. Only exact current status keys match.

Before opening, statusline fully disposes the selector, re-queries to validate the selected action identity, and rechecks session generation, live branch prefix, context and status key. Open admission times out after two seconds. Both requests support cancellation and clean up timers/listeners. Provider data grants no command-execution or session-control authority.

## Default information hierarchy

The balanced Signalridge profile shows, in order:

- current model;
- active thinking level, only when it is not `off`;
- compact cwd/repository location;
- branch and semantic Git state;
- active tool or streaming activity, only while active;
- context percentage, right-aligned where possible.

Narrow terminals progressively drop lower-priority fields and truncate long model names without emitting partial ANSI sequences. Extension statuses appear on a separate wrapped line. They are text-only by default; explicit `extensionStatusIcons` entries can add a badge for a selected active state, and an empty string suppresses one.

Model ids, provider ids, active tool names, directory names, and Git branch names are sanitized before display. Escape sequences are removed with their DCS/OSC/PM/APC/SOS payloads, and control characters and bidirectional overrides are dropped rather than replaced, so spoofed text can neither reverse the footer nor shift its layout. An introducer with no terminator drops only itself: consuming the rest of the string would let one byte in a branch name erase the tail of the footer. The branch is sanitized before the optional GitHub PR context is composed in, so the PR hyperlink stays clickable.

## Lifecycle behavior

The footer is installed only for TUI sessions. Git status is collected asynchronously and cached outside rendering, with stale cwd/branch results discarded. Usage totals are maintained by a runtime-owned incremental snapshot: rendering does not rescan session history; session replacement, branch/compaction boundaries rebuild it and message/turn events update it. Standalone usage entries (including cache warming) count toward historical tokens, cache, and cost. When tokens, cache, or cost is configured, the footer checks the session leaf every five seconds (including while idle), copying history only after the leaf changes and inspecting only entries appended since its last check. Presets without those segments skip the usage check. Context percentage comes from `ctx.getContextUsage()`, subject to the display-confidence guard below. Footer timers, branch listeners, pending Git work, command menus, and session ownership are cleaned up on footer disposal, session replacement, compaction, and shutdown. Context usage refreshes after compaction events.

### Cost origin

`/statusline status` reports `provider-reported`, `estimated`, `unknown/legacy`, or
`mixed/unconfirmed` without adding footer clutter. Only finite nonnegative totals (including zero)
with an explicit boolean `usage.cost.totalFromProvider` flag establish provider or estimated origin.
Missing/invalid totals or flags remain unconfirmed, even beside confirmed usage. Aggregation includes
all existing usage-bearing entry types, and replacement removes the previous entry's attribution as
well as its numeric contribution. Numeric totals and footer formatting are unchanged. There is no
price catalogue, pricing configuration, or requested-model/tier repricing.

### Context display confidence

After an observed failed or aborted assistant response, or failed/cancelled compaction, the footer shows `ctx ?` instead of a potentially misleading percentage (optional powerline palettes retain their existing `?/window` form). Successful compaction also leaves context unknown until a fresh response establishes usage. Starting/ending/settling an agent run, queued/custom notifications, zero-usage responses, and standalone cache-warming usage do not restore confidence. Restoration requires a new successful, non-aborted/non-error assistant response with finite positive provider token usage for the current provider/API/model route; the normal public API percentage and colors then return unchanged. Model changes require fresh evidence rather than reusing the previous route's trust. Invalid/nonfinite percentages display as unknown; valid overflow percentages are never clamped.

Confidence is rebuilt from the active session branch at startup/resume/reload and tree navigation, including raw failed assistant attempts even when excluded from model context. Because Pi does not persist failed compaction events, each owned failure appends one plain custom session entry named `pi-statusline:context-confidence` with only `{version:1,state:"unknown"}`. It contains no messages, provider errors, token counts, or credentials and is not sent to the model. Only this extension's validated metadata is replayed, in branch order; later qualifying same-route successful usage can supersede it. Existing failed assistant records and successful compaction boundaries need no additional entries. Startup, rebuild and rendering never append metadata.

Abandoned branches do not supply confidence. Live recovery requires an admitted assistant stream: each public start is a new occurrence even when timestamps repeat, and a response ID assigned after start does not change that admission. A finish without a current start cannot restore trust; failed/aborted finishes conservatively invalidate it. Session, route, branch and UI retirement discard in-flight admissions. After installation, confidence checks walk only newly appended ancestry through public parent links rather than rescanning the whole branch; missing, cyclic or non-descendant ancestry retires confidence until tree/session rebuild. Nonassistant messages do not trigger these checks. Hosts/history fixtures without failure evidence keep the existing public API behavior. Rendering reads this event-maintained state without rescanning history.

This is a truthful-display guard, not repaired token accounting: it does not reconstruct tokens, replace Pi's estimator, or repair upstream overflow recovery or compaction cancellation. An unknown display does not imply that compaction succeeded or that the next request will fit.

Retained footer callbacks also check the live mode and UI eligibility before work: a headless rebind retires both clocks, branch subscriptions, and pending Git requests even while an earlier session handler is awaited. This resource-only cleanup neither clears a replacement footer nor renders or emits status/settings notifications through the retained UI.

The JSON editor honors Pi's configured external editor. Session replacement or reload retires the dialog without killing that program or restoring its obsolete draft; when the program exits, the surviving terminal may resume. Quit suppression requires statusline to remain loaded in the replacement session. If a reload removes the extension, no replacement instance can observe later quit, so the pending editor retains the host's native restart behavior.

<a id="package-layout"></a>

Source entrypoint: `src/index.ts`.

## Local divergence

Signalridge maintains the modular port, canonical/legacy settings behavior, session-safe refresh cleanup, context display-confidence guard, and the restrained text-first default appearance described above. Git capture is bounded per operation: status gets 1 MiB and root discovery 16 KiB, counting stdout and stderr together. Incomplete status is not parsed; root discovery failure alone does not discard valid status. Passive debounce, Git refresh, and usage timers do not keep the process alive.

## License

MIT. See [`LICENSE`](./LICENSE).

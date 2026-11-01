# pi-welcome

TUI-only Signalridge startup card: one rounded panel with the current
repository, model, context budget, key hints, and a live resource inventory. It
uses the active Pi theme, persists workspace facts in a bounded custom entry,
and collapses to a width-safe compact summary on narrow terminals. Resume keeps
the original workspace facts but refreshes inventory when creating the renderer.
A card summarized by compaction is restored from the active branch, never from
an abandoned branch.

```
╭─────────────────────────────────────────────────────────────────────────╮
│                                                                         │
│  Ctrl+C interrupt · / commands · ! bash · Ctrl+L clear                  │
│                                                                         │
│  Directory:  ~/code/acme-api                                            │
│  Branch:     main [+392 -202]                                           │
│  Session:    (new)                                                      │
│  Model:      openai-codex / gpt-5.6-luna · thinking max                 │
│  Budget:     400K · compacts at 270K                                    │
│  pi v1.4.0                                                             │
│                                                                         │
│  Inventory:  live at render                                            │
│  Context:    AGENTS.md                                                  │
│  Skills:     commit, release, review +12                                │
│  Prompts:    /plan, /ship +4                                            │
│  Configured packages: btw, goal, statusline +18                         │
│  Available themes: dark, light, system +2                              │
│  Tools:      18 active of 42                                            │
│                                                                         │
╰─────────────────────────────────────────────────────────────────────────╯
```

The card leads with a compact Pi mark and the running host version.

## Install

The current tested host is Pi `1.4.0`. Host-provided dependencies use `"*"` peers to identify module ownership, not to guarantee compatibility with every Pi version. See the [compatibility guide](https://github.com/signalridge/pi-extensions/blob/main/docs/compatibility.md) for verification details.

```bash
pi install npm:@signalridge/pi-welcome
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-welcome
```

## Turn on `quietStartup`

The card is designed to be the whole opening screen. Pi's own startup is a
separate header, key-hint block, and one `[Section]` per resource kind with a
blank line between each; leaving both on shows two unrelated designs and about
forty-five lines of them. Set:

```json
{ "quietStartup": true }
```

in `~/.pi/agent/settings.json` (or `/settings` → Quiet startup). Pi then prints
nothing at startup and this card stands alone. Diagnostics — resource
collisions, extension load errors — are still shown when quiet, so nothing
actionable is hidden.

Leaving `quietStartup: false` is supported and changes nothing about the card;
Pi simply prints its own block above it again.

## Where the inventory comes from

With `quietStartup` on, Pi's `[Context]`/`[Skills]`/`[Prompts]`/`[Themes]`/
`[Extensions]` sections are gone and nothing brings them back — `/reload` re-runs
the same suppressed listing — so this card is the only place they appear. It
names them rather than counting them, capped at eight per row with a `+N` tail.

Skills and prompts come from `getCommands()`, **not** from `loadSkills()`. An
extension may contribute skill paths through `resources_discover`, which is
where most of them come from in practice, and the standalone loader cannot see
those: on a session showing dozens of skills it returns zero. `getCommands()`
reports what Pi actually registered. Collection happens at renderer component
creation, after `bindExtensions()` finishes `resources_discover`, not during
`session_start` before discovery. The inventory is labeled **live at render**;
it is not a persisted startup snapshot.

**Configured packages** comes from `pi.getSettings()`, which already resolves
project trust and merges configuration. Packages filtered to no resources are
omitted; skills-only packages may appear. This is configuration, not evidence
that a package's extensions loaded, and does not enumerate standalone extension
files. **Available themes** comes from `ctx.ui.getAllThemes()` in the TUI,
including built-in and discovered themes rather than only a user themes folder.
Context filenames come from `loadProjectContextFiles`, and tool counts from
`getAllTools()` / `getActiveTools()`. Nothing here constructs or reloads a second
resource loader: its `reload()` re-executes every extension factory and would
duplicate tools, listeners, timers, and child processes.

The persisted Budget row uses effective trusted settings, resolving the exact
`provider/modelId` compaction override, ordinary reserve, then Pi's default
reserve. Zero is valid; invalid settings do not produce a guessed threshold.
When automatic compaction is disabled, there is no **compacts at** suffix.

## Untrusted text

A directory name, a git branch name, and a session name are all
attacker-controlled in a cloned repository, and the card is a persisted entry
replayed on every resume. Control characters and bidirectional overrides are
neutralized at render time, so an entry stored before that landed is cleaned up
on the way out too.

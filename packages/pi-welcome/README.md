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

To show the card without Pi's separate startup listing, set:

```json
{ "quietStartup": true }
```

in `~/.pi/agent/settings.json` (or `/settings` → Quiet startup). Resource collisions and extension-load diagnostics still appear. `false` is supported: Pi's own startup block appears above the unchanged card.

## Where the inventory comes from

Inventory is **live at render**, collected when the renderer is created after resource discovery, not persisted with startup facts. Rows show at most eight names plus a `+N` tail; quiet startup and `/reload` leave native resource listings suppressed.

- Skills/prompts: `getCommands()` reports actual registrations, including extension-provided `resources_discover` skills that standalone `loadSkills()` cannot see.

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

# pi-welcome

TUI-only Signalridge startup card: one rounded panel with the current
repository, model, context budget, key hints, and the inventory of what Pi loaded. It
uses the active Pi theme, persists a bounded custom entry so a resumed session
redraws it, and collapses to a width-safe compact summary on narrow terminals.

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
│  Version:    0.84.1                                                     │
│                                                                         │
│  Context:    AGENTS.md                                                  │
│  Skills:     commit, release, review +12                                │
│  Prompts:    /plan, /ship +4                                            │
│  Extensions: btw, code-actions, goal, gpt-fast, statusline +18          │
│  Themes:     catppuccin-mocha +2                                        │
│  Tools:      18 active of 42                                            │
│                                                                         │
╰─────────────────────────────────────────────────────────────────────────╯
```

No logo and no wordmark: the card exists to say what this session is, and a
brand line says nothing a returning user does not already know.

## Install

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
reports what Pi actually registered.

Extensions and themes are read from the same settings files and directories Pi
reads. Context files come from `loadProjectContextFiles`, and tool counts from
`getAllTools()` / `getActiveTools()`. Nothing here constructs a second resource
loader: its `reload()` re-executes every extension factory and would duplicate
tools, listeners, timers, and child processes.

## Untrusted text

A directory name, a git branch name, and a session name are all
attacker-controlled in a cloned repository, and the card is a persisted entry
replayed on every resume. Control characters and bidirectional overrides are
neutralized at render time, so an entry stored before that landed is cleaned up
on the way out too.

# pi-statusline — quiet text footer for Pi

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-statusline` is a theme-native footer for the [Pi coding agent](https://pi.dev). Its default Signalridge profile is a restrained, text-first two-line hierarchy: model and thinking state, workspace and branch metadata, active work, and context usage. Context is placed at the right edge when the terminal is wide enough.

Typical output is similar to:

```text
gpt-5.6-sol · think max · main                         ctx 42%
```

There are no persistent branch icons, emoji, powerline blocks, hard-coded backgrounds, or ornamental per-segment symbols in the default profile. A single dim `·` separator is used between text fields. Normal metadata is muted; accent and warning/error colors are reserved for current or abnormal state.

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
/statusline settings edit and apply the canonical JSON document
/statusline status   show the effective source and diagnostics
/statusline help     show configuration help
```

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

The footer is installed only for TUI sessions. Git status is collected asynchronously and cached outside rendering, with stale cwd/branch results discarded. Usage totals are maintained by a runtime-owned incremental snapshot: rendering does not rescan session history; session replacement, branch/compaction boundaries rebuild it and message/turn events update it. Footer timers, branch listeners, pending Git work, command menus, and session ownership are cleaned up on footer disposal, session replacement, compaction, and shutdown. Context usage refreshes after `session_compact`.

## Package layout

```text
packages/pi-statusline/
├── src/
│   ├── statusline.ts          # thin Pi lifecycle entrypoint
│   ├── commands.ts            # settings and menu workflows
│   ├── render.ts              # data-to-segment projection
│   ├── powerline.ts           # restrained text and optional powerline renderers
│   ├── settings.ts            # canonical/legacy loading and atomic saves
│   ├── git-status.ts          # argv-based asynchronous Git status
│   ├── extension-status.ts    # text-only extension status projection
│   └── presets/               # optional palette ramps
├── test/
├── README.md
├── LICENSE
└── package.json
```

## Local divergence

Signalridge maintains the modular port, canonical/legacy settings behavior, session-safe refresh cleanup, and the restrained text-first default appearance described above.

## License

MIT. See [`LICENSE`](./LICENSE).

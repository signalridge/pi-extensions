# pi-files-widget

In-terminal file browser and diff viewer widget for Pi. Navigate files, view diffs, select code, and send comments to the agent without leaving the terminal and without interrupting your agent.

Directory symlinks are shown with a `↗` marker and can be expanded like normal folders.

## Install

**Quick install (Pi package manager):**

```bash
pi install npm:@signalridge/pi-files-widget
```

<a id="dependencies-required"></a>

Required deps (needed for /readfiles):

```bash
# macOS (Homebrew)
brew install bat git-delta glow

# Debian 13+ / Ubuntu 25.04+
sudo apt-get install -y bat git-delta glow
# Debian and Ubuntu install bat as batcat; files-widget looks for bat
mkdir -p ~/.local/bin && ln -s /usr/bin/batcat ~/.local/bin/bat
```

On other systems, install [bat](https://github.com/sharkdp/bat#installation),
[delta](https://dandavison.github.io/delta/installation.html) and
[glow](https://github.com/charmbracelet/glow#installation) with your package
manager. The `bat`, `delta` and `glow` commands must be on your `PATH`.

Optional resource filter in `~/.pi/agent/settings.json` (installation already loads the manifest's extension):

```json
{
  "packages": [
    {
      "source": "npm:@signalridge/pi-files-widget",
      "extensions": ["index.ts"]
    }
  ]
}
```

**Local-clone alternative** (use one source, not both):

Add to your Pi extensions list:

```json
{
  "extensions": [
    "./packages/pi-files-widget"
  ]
}
```

If you prefer symlinking into `~/.pi/agent/extensions`:

```bash
ln -sfn "$(pwd)/packages/pi-files-widget" ~/.pi/agent/extensions/pi-files-widget
```

Then reference it in your settings:

```json
{
  "extensions": [
    "~/.pi/agent/extensions/pi-files-widget"
  ]
}
```

`/readfiles` refuses to open without the dependencies above: bat for highlighting, delta for diffs and glow for Markdown.

The browser is TUI-only. Retained browser callbacks and polling retire their resources when the live context leaves TUI mode or loses UI access, even before this extension's next session handler runs. Retirement does not close a replacement UI or send comments, notifications, or Git requests.

## Commands

- `/readfiles` - open the file browser in the current directory
- `/readfiles <path>` - open the file browser rooted at `<path>` (absolute, relative, or `~`-prefixed)

Diff viewing is built into the file viewer: changed tracked files open in diff mode by default; press `d` to toggle between diff and full-file view. Selection and comments are disabled in diff mode. Press `d` for the full file before selecting source lines.

## Browser keybindings

- `j/k` or `↑/↓`: move
- `Enter`: open file / expand folder
- `h/l` or `←/→`: collapse/expand folder
- `PgUp/PgDn`: page up/down
- `c`: toggle changed-only view
- `]` / `[`: next/prev changed file
- `/`: search (type to filter, `Esc` to exit)
- `u`: go up one directory (re-root to parent)
- `.`: jump back to the starting directory
- `+` / `-`: increase/decrease browser height
- `q`: close

## Viewer keybindings

- `j/k` or `↑/↓`: scroll
- `PgUp/PgDn`: page up/down
- `g/G`: top/bottom
- `d`: toggle diff (tracked files only)
- `m`: toggle rendered/raw view for Markdown files
- `/`: search (type to search, `Enter` to keep matches, `Esc` to cancel)
- `n` / `N`: next/prev match (wraps through confirmed matches)
- `v`: source-line selection from the top of the file (not available in diff mode)
- `c`: comment on selected lines (inline prompt)
- `Enter`: new line in the comment editor
- `Ctrl+Enter` or `Ctrl+D`: send the comment (`Alt+Enter` also works when supported)
- `]` / `[`: next/prev changed file
- `+` / `-`: increase/decrease viewer height
- `q`: back to browser

## Notes

- Untracked files show as `[UNTRACKED]` and open in normal view.
- Search temporarily displays plain, numbered full-file source, hard-wrapped at the available content width. It does not interpret bat/glow/delta rows as source lines, including when opened from a diff. Each matching source line has one result, revealing its first occurrence; `Enter` keeps this presentation and `n`/`N` navigation across resize. `Esc` clears search and restores ordinary formatting. Searching in rendered Markdown switches to raw mode first. In rendered Markdown, the first `v` switches to raw; press `v` again to select source lines.
- Ordinary full-file viewing remains syntax-highlighted and may wrap long lines. Selection uses an unhighlighted source snapshot with exactly one source line per row, starting at line 1 rather than reusing rendered-row scroll positions. Long lines are clipped to the terminal width, not wrapped; comments include the entire selected source lines. The displayed line numbers, selected range, and comment snippet use the same source indices. Resizing or disk edits do not change an active selection/comment snapshot. Cancelling or sending restores ordinary viewing.
- When you browse outside the current project directory, inline comments on those files use absolute paths so the agent can still locate them. Files inside the project continue to use project-relative paths.
- Folder LOCs are shown only when the folder is collapsed (expanded folders would duplicate counts).
- Line counts load asynchronously; the header shows activity while counts are computed.
- Large non-git folders load progressively and may show `[partial]` while loading in safe mode.
- Change metadata refreshes every 3 seconds while `/readfiles` is open, including outside Git repositories. Git discovery and refresh run asynchronously with bounded queries; closing or re-rooting cancels obsolete requests. Cancellation and timeouts release a query slot only after the direct Git child is confirmed terminated (a successful kill request alone is not confirmation). Inherited output pipes are then closed locally without signalling descendants. `[Git loading]` marks pending metadata; `[Git unavailable; stale]` means the last complete snapshot is retained rather than treating a failed or oversized query as clean.
- Filesystem scans and line counts use separate serialized pumps, including across root changes. Sibling directory/symlink metadata is limited to four concurrent operations; line counts retain their eight-file batch limit. Injected rows and symlink cycle boundaries are reconciled before publishing sorted results.
- The robot badge marks successful agent write/edit results. A neutral `~` marks changes observed during a failed or cancelled call: these may be an already-written agent change or a concurrent human save, so authorship is unknown. Both appear in changed-only view and next/previous change navigation. A later successful write confirms attribution; session changes clear both sets.

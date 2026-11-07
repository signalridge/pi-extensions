# pi-input-history

**Cross-session prompt history and an fzf/atuin-style fuzzy Ctrl+R popup for pi.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

## Why

Persist the last 100 prompts across sessions, beyond Pi's native current-session ↑/↓ history, and search them with **Ctrl+R**.

## Install

```bash
pi install npm:@signalridge/pi-input-history
```

## Use from this checkout

From the repository root:

```bash
pi -e ./packages/pi-input-history
```

<a id="features"></a>

## Usage

### Persistent history

On session start, your last 100 prompts across all sessions are loaded into the editor. Use **↑/↓** arrows to browse them as usual. If you submit a prompt or use history navigation before the background scan finishes, that editor is not seeded: your newer native history and browsing state take priority. The scanned prompts remain available through **Ctrl+R**, without replacing the editor. Startup replacement preserves a completed large paste through the focused editor's public expanded-text API when available; unknown focus and older hosts without that API use the host's normal text-copy behavior.

### Fuzzy popup (Ctrl+R)

1. Press **Ctrl+R** to open the popup — a large centred two-pane dialog, `fzf --preview` style. The left pane lists your recent prompts newest-first, each row carrying its position and age; the right pane shows the **full text** of the highlighted entry, which one-line summaries cannot convey for long prompts.
2. Type to fuzzy-filter the list live (subsequence matching, space-separated multi-token).
3. The selected row is highlighted full-width; matched characters use grapheme-safe accent underlining. Results deduplicate cached cross-session prompts and merge live branch history.
4. Navigate and accept:

| Key                         | Action                       |
| --------------------------- | ---------------------------- |
| `↑` / `Ctrl+P` / `Ctrl+S`   | Move up the list (newer)     |
| `↓` / `Ctrl+N` / `Ctrl+R`   | Move down the list (older)   |
| `Ctrl+D` / `Ctrl+U`         | Scroll the preview pane      |
| `Enter`                     | Accept selection into editor |
| `Esc` / `Ctrl+G` / `Ctrl+C` | Cancel                       |

Arrow and Emacs bindings follow the list (`Ctrl+P`/`Ctrl+N` = previous/next line); `Ctrl+R`/`Ctrl+S` keep their shell meaning, so pressing **Ctrl+R** again walks further back in history. Below 76 columns the preview pane is dropped and the list takes the full width.

History stores the original leading/trailing whitespace and multiline text. All ordered text parts are concatenated without adding separators; search and previews use separate display copies. Recall is **text-only**: image-bearing messages contribute their text, but images are not restored. The host editor may normalize tabs and line endings when text is inserted.

The native-TUI popup needs at least five terminal rows. Opening or shrinking below that minimum cancels without changing the draft.

## Selective upstream compatibility

The native fallback editor's embedded working-status layout is selectively ported from [ouzhenkun/pi-input-history](https://github.com/ouzhenkun/pi-input-history/commit/5824bd6ff04de6545e02acd8537fd869aa9f16a6). An inherited editor factory is left unchanged, including when composed with an input-prefix editor. Draft-preserving startup and history safeguards remain local; configurable shortcuts and highlight replacement are not included in this port.

## Acknowledgments

The Ctrl+R reverse search component is inspired by [pi-readline-search](https://github.com/mrshu/pi-readline-search) by [@mrshu](https://github.com/mrshu).

## License

MIT

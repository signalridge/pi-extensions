# pi-recall — saved messages for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-recall)](https://www.npmjs.com/package/@signalridge/pi-recall) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> Pi Recall is experimental. Its storage format and interaction flow may change between releases.

Healthy startup, reload, and resume do not emit an experimental warning. Command and storage errors are still reported when the affected action runs.

`@signalridge/pi-recall` saves selected text messages from the active Pi session branch and lets you preview or quote them in another session. Saved content remains local until you explicitly insert a quote into a draft and submit it.

## Install

Install persistently from npm:

```bash
pi install npm:@signalridge/pi-recall
```

Try from npm without installing permanently:

```bash
pi -e npm:@signalridge/pi-recall
```

Try this package from a local checkout:

```bash
pi -e ./packages/pi-recall
```

<a id="features"></a>

## Quick start

1. Run `/recall`.
2. Choose **Save a message** and select a text user or assistant message from the active branch.
3. In any later session, run `/recall` and choose **Recall a saved message**.
4. In TUI mode, type to fuzzy-search or press `Tab` / `Shift+Tab` to change scope. RPC mode asks for scope explicitly.
5. Press `Enter` to open the selected message, or press `Ctrl+D` to review and confirm its deletion directly from the TUI picker.
6. Preview the message or choose **Quote into draft** in TUI. In RPC, choose **Replace client draft with quote** and confirm replacement.
7. Add your question or instruction, then submit the draft normally.

A quoted draft uses this form:

```xml
<recalled_message role="assistant" message_timestamp="2026-08-04T12:34:56.000Z">
Original message text
</recalled_message>

The user intentionally recalled and quoted the saved message above.
```

The quote sent to the editor omits cwd, session IDs, entry IDs, session files, and other local paths. ESC and XML-forbidden controls are encoded visibly (for example, `\u001b`), so saved text cannot terminate a bracketed paste. Multiline quote text and raw stored content remain intact.

## Commands

| Command | Modes | Description |
| --- | --- | --- |
| `/recall` | TUI, RPC | Open the Pi Recall manager. Arguments are rejected. |

Print and JSON modes reject `/recall` before opening an interactive flow. TUI and RPC expose the same save, preview, quote, delete, status, and help capabilities; RPC uses explicit dialogs instead of terminal shortcuts. RPC cannot read or append to the client draft. After explicit confirmation, quoting emits Pi's `set_editor_text` extension UI request to replace the entire draft; cancellation leaves it untouched.

## Recall scopes

- **Current cwd** — saved messages whose normalized absolute source cwd matches the current cwd. This is the default for each new `/recall` interaction.
- **All** — every valid record in the current Pi agent directory.
- **Current session** — records whose source session ID exactly matches the current session.

Each interaction owns its opening session and branch path. Ordinary appends (including metadata entries) keep that path active and do not cancel pending selections or quote confirmations: the live check accepts the opening path as a prefix of the active branch. A committed tree event retires the interaction even when that prefix survives; moving backward, to a sibling, or to an empty branch is detected from the live public session manager even before Recall's tree handler runs. Cancelled navigation with an unchanged branch leaves it usable. Reopen `/recall` after navigation for fresh candidates.

Scope applies only when recalling already saved messages. The save picker intentionally reads only `ctx.sessionManager.getBranch()` from the current session and never scans other session files. TUI scope switching keeps the selected saved record when it remains visible in the new scope; otherwise it selects the first fuzzy-ranked result or the newest result when the query is empty.

## TUI fuzzy search

The TUI picker has a visible `Search:` input. It matches complete saved message text, the `user` or `assistant` role, and the optional session name after scope filtering. Matching is case-insensitive and requires every whitespace- or slash-separated token as an ordered subsequence. It ranks closer matches first but does not perform typo-edit-distance correction.

The query and selection survive scope changes and selected-message navigation during one `/recall` interaction. A new `/recall` starts with an empty query and **Current cwd**. Queries are limited to 256 UTF-16 code units; an overlong query shows an error and runs no matching. Terminal controls are replaced before matching or display, while ordinary spaces remain available for multi-token queries.

`Ctrl+D`—or the configured `app.session.delete` binding—opens a confirmation identifying the selected record and showing a bounded preview. Cancellation returns to the unchanged picker. After confirmation, Pi Recall shows non-cancellable deletion progress, applies the existing locked atomic JSONL mutation, and returns to the same scope and query with a neighboring result selected. A failure keeps the previous list visible and reports how to retry; a record concurrently removed elsewhere is reconciled as already absent. Plain `Delete` remains available for forward editing in the search input. The existing `Enter` → **Delete…** route remains available when a complete saved-text review is preferred.

RPC continues to show the complete scoped list through explicit dialogs and does not simulate a hidden fuzzy query or terminal shortcut. Message timestamps, cwd, session IDs, entry IDs, and local paths are not searchable.

## Storage, privacy, and recovery

The canonical user file is:

```text
~/.pi/agent/pi-recall.jsonl
```

Pi's configured agent directory replaces `~/.pi/agent` when applicable. Each line is one active versioned `recall_message` record. Records contain the text, role, saved time, original message time, source cwd, source session ID, source entry ID, and optional session name. This provenance is shown locally but is excluded from generated quote payloads except for role and original message time.

Pi Recall does not create settings, session custom entries, tools, background processes, watchers, or automatic model context. It reads storage only when `/recall` needs it.

Save and delete operations acquire one cross-process lock, reread canonical storage under that lock, and publish a complete JSONL replacement through a unique same-directory `0600` temporary file. Lock waiting is abort-aware. The canonical file is required to be a regular non-symlink file and is kept at `0600`. Live interaction ownership is checked immediately before dispatching canonical replacement; a filesystem operation already dispatched while current cannot be retracted.

Invalid UTF-8, malformed JSON, duplicate IDs, unknown record types or versions, invalid records, symlinks, and limit violations make storage read-only, including its existing permission bits. Bytes are decoded strictly and the complete JSONL is validated before canonical permission repair. Fix or move the reported file, then reopen `/recall`; Pi Recall never overwrites invalid storage. Unknown fields on otherwise valid version-1 records survive later rewrites.

Deleting a message removes it from canonical `pi-recall.jsonl`. It is not secure erasure of filesystem blocks, backups, snapshots, temporary copies left by an operating-system failure, or content already quoted into a session.

## Message semantics and limits

- Eligible sources are `message` entries with role `user` or `assistant` on the active branch.
- User strings and text blocks are kept; multiple text blocks are joined in source order with newlines.
- Thinking, tool calls, tool results, images/base64, custom messages, image-only messages, empty text, and abandoned branches are not saved.
- Markdown, indentation, Unicode, and original line breaks are preserved. Oversized messages are excluded rather than truncated.
- A source message can be saved only once for the same source session ID and entry ID.
- At most 200 messages may be saved.
- One message text may contain at most 50,000 UTF-8 bytes.
- Canonical JSONL may contain at most 12 MiB.
- Records are never evicted automatically.

Terminal controls are removed from labels, previews, metadata, and errors before display, including escape sequences with their DCS/OSC/PM/APC/SOS payloads and bidirectional overrides that would reverse how a recalled message reads. Sanitizing happens before truncation, so a preview budget buys visible characters, and an introducer with no terminator drops only itself rather than hiding the rest of a message from the preview and the fuzzy filter. Full review content is passed through Pi TUI Kit's sanitized review renderer. The raw stored text is not modified merely for display.

## Experimental limitations

- No tags, saved-query persistence, message editing, reordering, batch deletion, import/export, automatic expiry, or automatic context injection.
- No cross-session transcript browser: only previously saved records can be recalled across sessions.
- The custom TUI picker is keyboard-operated. RPC uses sequential dialogs.
- Custom UI completion uses the shared public-API editor-preservation adapter: observable writes before completion survive the host's saved-draft restoration, and later destination writes remain authoritative. This is not a universal ownership guarantee; invalid contexts and indistinguishable writes of the opening draft cannot be recovered.

<a id="package-layout"></a>

Source entrypoint: `src/index.ts`.

## License

MIT. See [`LICENSE`](./LICENSE).

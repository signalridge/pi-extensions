# pi-btw — side questions for the Pi coding agent

[![npm](https://img.shields.io/npm/v/@signalridge/pi-btw)](https://www.npmjs.com/package/@signalridge/pi-btw) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-btw` is a native [Pi coding agent](https://pi.dev) extension that adds `/btw`, a side-question command for quick clarifications that should not interrupt or pollute the main agent conversation.

Use it when you want to ask a temporary question, inspect context, or get a short explanation while keeping the primary coding task focused.

## Features

- Adds a `/btw` menu for starting or resuming an in-memory side thread or changing pi-btw settings.
- Keeps `/btw <question>` as a direct fast path that always starts a fresh side thread.
- Lists titled, non-empty side threads by first question and latest answer or visible error activity; the Resume picker is bounded and searchable.
- Answers side questions in a dedicated, scrollable full-screen UI.
- Keeps mouse-drag copying stable while the main agent continues running in the background.
- Supports follow-up questions in the same ephemeral side thread.
- Queues Pi-style `Steering` questions while an answer is running and processes them one at a time.
- Optionally brings the latest answer, a question-to-end suffix, an exact line range, or the entire side thread into the main editor.
- Uses the current session branch as context.
- Uses Pi's current model or an independent model selected in `pi-btw.json`.
- Uses a pi-btw thinking level that can be changed with Pi's configured thinking shortcut and remembered for next time.
- Does not append the side question or answer to the main conversation.
- Works as an independently installable npm Pi extension package.

## Install

```bash
pi install npm:@signalridge/pi-btw
```

Try without installing permanently:

```bash
pi -e npm:@signalridge/pi-btw
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-btw
```

## Usage

Open the pi-btw menu or provide the first question immediately:

```text
/btw
/btw <your side question>
```

Examples:

```text
/btw
/btw what does this TypeScript error mean?
/btw summarize the current implementation before we continue
/btw is this API name idiomatic?
```

Running `/btw` alone opens a menu. **Start side thread** is selected first, so pressing `Enter`
opens an empty ephemeral side thread. If titled, non-empty threads exist, **Resume side thread**
opens a bounded searchable picker showing each first question and question count; rows retain raw
thread IDs, so duplicate titles remain unambiguous. Threads are ordered by their latest answer or
visible error, and opening one without a new result does not reorder it. **Settings** changes the
starting thinking level and whether shortcut changes are remembered. `/btw <question>` bypasses this
menu and always starts a fresh side thread; its answer opens above the side-thread editor. The
resumable picker is adapted from narumiruna/pi-extensions commits `be8d4922` and `69e84851` while
retaining Signalridge's fullscreen, steering, malformed-response, and provider hardening. The side
thread uses a dedicated full-screen terminal view.
The main agent continues running in the background, but its screen rendering stays suspended until
`/btw` closes, so new main-thread output cannot move a mouse selection inside the side thread.
Drag the primary mouse button across side-thread text to select and copy it through Pi's terminal
clipboard support. Returning from `/btw` redraws the main view with everything produced while it
was hidden. A compact `btw · side thread` header stays fixed above the content so the ephemeral
workspace remains recognizable while scrolling. Messages use Pi's normal
user and assistant presentation without numbered turns or role labels. Type each question and press
`Enter`; no follow-up shortcut is required.
Previous side questions and answers remain available to the model and visible whenever that
side thread is resumed. The side-thread header shows its current thinking level. Press Pi's configured
`app.thinking.cycle` shortcut (`Shift+Tab` by default) in the composer to cycle the levels
supported by the side-thread model; every later question uses the displayed level until it is
changed again. By default, each shortcut change is also written to `pi-btw.json` for the next
invocation. Turn **Remember thinking level changes** off in Settings to keep changes local to the
current side thread. Neither path changes the main session's thinking level.
While a response is running, the transcript and composer remain visible above an `Answering…`
status.
Type another question and press `Enter` to queue it as `Steering`; queued questions are shown in
submission order and answered one at a time after the active response completes.
A queued question uses the side thread's thinking level when its turn begins.
A failed active response is shown in the transcript and does not discard later steering questions.
The footer shows `PgUp`/`PgDn` only when history can scroll; press `Ctrl+C` to cancel the active
response and discard the ephemeral side-thread draft and steering queue.
Steering remains entirely inside pi-btw and never appends to the main conversation or editor.

After at least one successful answer, press `Ctrl+R` to bring selected context to the main
editor. The scope menu shows the size of the latest question and answer and the entire side
thread before you choose. Bring the latest question and answer, everything from a chosen
question onward, an exact text range, or the entire side thread. Question-suffix, exact-range,
and entire-thread choices preview the exact editable context block before the side thread closes;
`Escape` returns and `Ctrl+C` closes without bringing anything to main.

The text-range selector supports both fast line selection and editor-style character selection.
It reports whether anything is selected plus the selected line, message, and approximate token
counts. Press `Space` to select the current raw source line, then use `Up`/`Down` to extend by
whole lines; press `Space` again to clear it. Alternatively, use the arrow keys to move the cursor
and `Shift`+arrow keys to extend a character-level selection. Starting a Shift selection replaces
any active line selection. Selected lines include a visible `●` marker in addition to highlighting.
Pi's configured keys control vertical navigation, bringing, and going back (`Up`/`Down`, `Enter`,
and `Escape` by default), and the selector displays the active keys. Selection follows raw source
text rather than terminal-wrapped visual rows.

Bringing context to main closes the side thread and loads a deterministic, editable context block
into Pi's main editor. It never sends the draft automatically. If the main editor already has a
draft, append is the recommended default. Replace is labeled as destructive and requires a second
confirmation; Cancel returns to the side thread without changing either draft. Concurrent editor
updates made while these menus are open are preserved. A success message reports whether context
was loaded, appended, or replaced and its approximate size. Without an explicit bring-to-main
action, closing `/btw` never adds the side thread to the main conversation. Completed questions,
answers, and visibly rendered errors remain only in memory for Resume during the current extension
instance; empty drafts, cancelled answers, steering queues, credentials, reloads, session changes,
and process restarts are not persisted.

## Model and thinking level

By default, `/btw` uses the current session model. To use an independent model for side
questions, create:

```text
$PI_CODING_AGENT_DIR/pi-btw.json
```

The normal location is `~/.pi/agent/pi-btw.json`. `PI_CODING_AGENT_DIR` is an existing Pi
setting; pi-btw does not add any environment variables.

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "low",
  "rememberThinkingLevelChanges": true
}
```

The `model` value uses `provider/model-id` format. Only the first `/` is the separator, so
model IDs may contain additional slashes, such as `openrouter/anthropic/claude-sonnet`.
The configured model must exist in Pi's model registry and have usable credentials. If it
cannot be found or authenticated, pi-btw warns and falls back to the current session model.
If neither model is available, `/btw` reports an error and stops. This selection affects only
`/btw`; it does not change the main session model.

Pi calls its reasoning setting the **thinking level**. `thinkingLevel` sets pi-btw's starting
level; accepted values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. When the
field is absent for backward compatibility, the next invocation starts from the current session
level. The initial value and shortcut cycle are clamped to the selected side model's capabilities
using Pi's model rules. Pi-btw does not read, write, or change the main session's
`defaultThinkingLevel`.

`rememberThinkingLevelChanges` controls only persistence and defaults to `true` when omitted. A
side-thread shortcut always changes that side thread immediately. When remembering is on, the
concrete level is written for the next invocation; when off, `pi-btw.json` stays unchanged. If a
shortcut write fails, the local change remains active and pi-btw warns that it was not remembered.
A failed Settings-screen save instead restores the previous displayed value.

A missing settings file is a side-effect-free read: pi-btw creates it only after a Settings change
or a remembered shortcut change. Saves are ordered within the Pi process and published atomically
with a same-directory temporary file and rename. They preserve `model` and unknown fields; malformed
or invalid files block saves and remain unchanged. Settings must be valid UTF-8 and no larger than
64 KiB, so unexpectedly large or invalidly encoded files are rejected without being rewritten.
Separate Pi processes and external editors are outside this in-process ordering boundary. The file
is read for each `/btw` invocation, so edits apply without `/reload`.

## Why use pi-btw?

Normal assistant messages become part of the main Pi conversation and can distract the coding agent from the task. `pi-btw` creates a lightweight side channel for context-aware questions, making it useful for pair programming, debugging, code review, and repository exploration.

## Package layout

```txt
packages/pi-btw/
├── src/
│   ├── index.ts
│   ├── btw.ts
│   ├── bring-to-main.ts
│   ├── menu.ts
│   ├── settings.ts
│   ├── side-thread.ts
│   ├── text.ts
│   └── transcript-pager.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## License

MIT. See [`LICENSE`](./LICENSE).

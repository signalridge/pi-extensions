# pi-btw reference

[Start with the README](../README.md).

- [Usage](#usage)
- [Optional Secrets cooperation](#optional-secrets-cooperation)
- [Settings writes](#settings-writes)
- [Selective upstream compatibility](#selective-upstream-compatibility)
- [Provenance](#provenance)

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

**Privacy behavior change:** `/btw` no longer forwards the parent session transcript or parent
system prompt to its independent provider by default. A side question without an opt-in sees only
that question and the side thread's previous questions and answers. Questions such as “summarize the
current implementation” now need details in the question itself or an explicit, destination-bound
parent-history opt-in (see [Parent history and privacy](../README.md#parent-history-and-privacy)).

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
side thread is resumed. An opted-in parent-history request can cause an answer to repeat private
details. From that point, the side thread is bound to the same physical model and effective endpoint:
a provider, model, or endpoint switch requires a **fresh side thread** so those previous answers
cannot be relayed by a later default request. Threads that never opted in can still switch models.
The side-thread header shows its current thinking level. Press Pi's configured
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
Pending commands and side threads validate their opening manager, session ID, leaf and full raw
branch-ID prefix at async boundaries. Ordinary appends and canceled navigation remain valid;
observed divergence retires the operation permanently, even before its tree handler runs. Queued
parent-history questions cannot read a destination branch or dispatch after that retirement.

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
was loaded, appended, or replaced and its approximate size. If a committed session switch or
tree navigation closes `/btw`, the shared custom-editor adapter preserves an observable editor
write made before completion and leaves a later destination write alone. Fullscreen host repair
also runs when a provider finishes after live branch retirement but before pi-btw's tree handler:
it is guarded by public context/editor identity, not by the retired thread's ownership. Retirement
still blocks queued provider dispatch and bring-to-main callbacks; host repair never replays cached
side-thread task data. This is not a universal editor-ownership guarantee: invalid SDK contexts
and indistinguishable writes of the opening text
cannot be recovered through Pi's public UI API. A canceled switch leaves an open side thread
running and its current main-editor draft unchanged.
Without an explicit bring-to-main action, closing `/btw` never adds the side thread to the main
conversation. Completed questions,
answers, and visibly rendered errors remain only in memory for Resume during the current extension
instance; empty drafts, cancelled answers, steering queues, credentials, reloads, session changes,
and process restarts are not persisted.

## Optional Secrets cooperation

If the experimental, opt-in `@signalridge/pi-secrets` extension is also loaded,
`/btw` and `advisor` use its public synchronous `pi-secrets:projection:v1` event
service. Secrets projects full eligible history **before** the 40,000-character
budget is applied, and the assembled side request is projected again. Questions,
prior side messages and parent context use the same discovered-secret registry.
Either load order works. With no Secrets service, the existing path is unchanged;
this package does not load or enable Secrets itself. A loaded service that refuses,
fails, returns malformed data or loses ownership blocks the request—never a raw
fallback. Admission is bounded to 50,000 strings/8 Mi characters per batch; larger
inputs are withheld, not partially projected. Caller JSON traversal is limited to
100 nested objects and 100,000 visited JSON values. See the Secrets README for the
public envelope contract. Executable/accessor JSON serialization hooks, including
inherited `toJSON` hooks in tool arguments, withhold the request without being run;
inert JSON keys named `toJSON` remain valid. Discovery/validation errors are generic
and never relay provider exception text. Promise replies, including cross-realm
native promises, are rejected synchronously while late rejections are observed
without reading arbitrary thenable getters.

This does not replay parent request hooks or change history/destination consent.
Without this cooperation, parent context remains unfiltered as described above;
other parent-hook redactions still are not inherited. Projection changes only the
request copy, never stored parent or side history. Replies keep placeholders; they
are not blanket-restored. Native tool execution retains its existing authorized
restoration behavior. Compaction generation, export, non-cooperating extensions,
system prompts, images and opaque replay/signature data are not covered. This is
cooperative text projection, not global protection or signed-provider acceptance.

## Settings writes

A missing settings file is a side-effect-free read: pi-btw creates it only after a Settings change
or a remembered shortcut change. Saves are ordered within the Pi process and published atomically
with a same-directory temporary file and rename. They preserve `model` and unknown fields; malformed
or invalid files block saves and remain unchanged. Settings must be valid UTF-8 and no larger than
64 KiB, so unexpectedly large or invalidly encoded files are rejected without being rewritten.
Separate Pi processes and external editors are outside this in-process ordering boundary. The file
is read for each `/btw` invocation, so edits apply without `/reload`. The optional `advisorModel`
key is the exception: it is read once when a session starts (see [Advisor tool](../README.md#advisor-tool)).

## Selective upstream compatibility

Per-thread provider routing identity is selectively ported from [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions/commit/81be3f7250b26bfd4d51ab20d193b5edae70e688). Each in-memory side thread owns an independent UUID passed as the provider session ID across follow-ups and resume; one-off side-question helpers get a new ID per call. The parent session ID and parent-history persistence are not used. Local privacy, destination binding, auth/header routing, cost reporting and fullscreen UI behavior remain unchanged.

## Provenance

The `advisor` tool adapts the design of `@juicesharp/rpiv-advisor` (MIT) from
[`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor),
read at commit `46dbdfd`: a model-invoked tool that forwards the current branch to a separately
configured reviewer model, sends that request with no tools, returns the reviewer's guidance as the
tool result, and turns every failure into an explicit tool error. The reviewer system prompt and
tool guidance were rewritten for Pi. Local divergence:

- One `advisorModel` key names the reviewer, resolved through pi-btw's existing model resolution.
  There is no `/advisor` picker, effort setting, per-model blocklist, tool-inventory prefix or
  global tool cache.
- The reviewer receives pi-btw's bounded text transcript (the `--with-parent` serialization), not
  the raw message list, so images, thinking, system messages and tool declarations never reach it.
- The interactive-session gate, the same-model refusal and the virtual-model and endpoint-override
  refusals are local. The empty-response retry and host retry wrapper are not ported.
- The provider routing identity is an independent UUID per session rather than a value derived
  from the main session's ID.
- Optional Secrets cooperation is a local public-event integration, with no source imports,
  duplicated detector/settings schema, provider registry or replay of native request hooks.
  Original upstream MIT notices remain in `LICENSE`.
- Advisor calls fence their opening session/branch across credential resolution and completion,
  and reject stale results instead of delivering them to another branch.

# @signalridge/pi-ui

Shared UI primitives for Signalridge Pi extensions.

## Bordered custom UI

Pi's native `ctx.ui.select()`, `confirm()`, `input()`, and `editor()` dialogs already own their terminal framing and RPC protocol. For extension-owned `ctx.ui.custom()` surfaces, use `withBorderedCustomUi()` when passing a context to a menu or UI library:

```ts
import { withBorderedCustomUi } from "@signalridge/pi-ui";

await runMenu(withBorderedCustomUi(ctx), menu, options);
```

The adapter adds the standard Pi top and bottom border rules to custom components that do not already render them. The outer rule uses the theme's `borderAccent` color (purple in the Signalridge themes). Existing bordered components are detected and are not double-framed. Keyboard input, focus, invalidation, disposal, overlay options, and RPC behavior are forwarded unchanged. On mouse-capable Pi versions, pointer events are forwarded with coordinates adjusted for added border rows; those rules are not content hit targets. Existing borders retain their original mouse geometry and handlers retain their capture/focus results.

Use `borderedComponent()` when a package owns the custom factory directly. Persistent widgets, footers, and deliberately full-screen views are not dialogs and should not be wrapped automatically.

## Safe display copies

Use `sanitizeDisplayText(text, options?)` on untrusted labels, filenames, metadata, and other **display copies**, before trusted theme styling:

```ts
import { sanitizeDisplayText } from "@signalridge/pi-ui";

const label = theme.fg("accent", sanitizeDisplayText(incomingLabel));
const preview = sanitizeDisplayText(incomingPreview, { multiline: true });
```

The default produces a single line. C0 controls (including ESC), DEL, C1 controls (including CSI/OSC/DCS/ST), bidi controls, and Unicode line separators become visible lowercase `\\uNNNN` escapes. Escaping introducers instead of parsing sequences also neutralizes incomplete sequences and strings joined from split input. Sequence payloads remain visible, so different hostile filenames are not silently collapsed by stripping ANSI. Ordinary Unicode, combining marks, emoji, ZWJ, and ZWNJ are preserved. With `multiline: true`, only LF and tab are retained as actual controls; CR and other controls still escape. Repeating sanitization with the same options is stable.

This is a pure display helper, not a reversible serialization or identity encoding: literal escape-looking text may match an encoded control. Never use its output in place of stored user answers, editor text, paths used for file operations, or other original data. It also escapes existing theme ANSI, so sanitize first and style afterward. Width measurement, wrapping, and clipping remain the caller's responsibility.

## Preserve editor changes across custom UI

`withPreservedCustomEditor(ctx)` is an opt-in context adapter for `ui.custom()` interactions that write to the main editor (for example, quoting a message and editing the quote). The SDK (1.0.4 through 1.4.0) normally restores the draft saved when a non-overlay custom UI opened, discarding editor writes made while it was open.

```ts
import { withBorderedCustomUi, withPreservedCustomEditor } from "@signalridge/pi-ui";

const menuCtx = withPreservedCustomEditor(withBorderedCustomUi(ctx));
await runMenu(menuCtx, menu, options);
```

Both composition orders work. Only the public custom factory/completion callback and returned promises are wrapped; native dialogs and editor methods are unchanged. Options, components, disposal, and `waitForPending()` ownership stay with the host. No listeners, renderer patches, private host access, settings, or extension registration are added.

The adapter captures current editor text immediately before the first `done(result)`. After host completion, it replays a changed capture **only if the editor still equals the opening snapshot**. The SDK's synchronous restoration is repaired before `done()` returns; the returned promise also covers deferred restoration. A later destination writer whose text differs from the opening snapshot wins, including a writer during host disposal. Duplicate completion is inert. Unchanged drafts incur no extra editor write. Sync/async factory failures capture before propagating the original error; preservation never masks that error. Throwing or invalid editor access disables preservation rather than retrying against a retired context.

### Public-API limits

This is not a universal editor-ownership or session-retirement fix:

- Cancel/abort flows should finish through the supplied `done()` callback. A host-side cancellation that bypasses that callback has no pre-restoration capture.
- Async factory rejection can be observed before restoration. Other host errors without a captured completion cannot be repaired reliably.
- The adapter does not await, replace, or wrap component `waitForPending()`. If pending work writes **after** `done()` but **before** a deferred host restoration, the host may erase that newer write; the adapter only knows the pre-`done()` capture. Await editor-mutating work before calling `done()`.
- Text equality is not an ownership token. A later writer deliberately writing the opening text before the first repair is indistinguishable from host restoration. Similarly, public expanded editor text can differ from a host's internal collapsed snapshot. Such hosts cannot be universally handled by this adapter.
- Public UI access has no session-generation or disposed-context token. Detectable invalid access fails closed, but an old context whose methods silently target a new session cannot be identified. Callers must retire their custom interaction before changing destination sessions, then use the fresh context. The adapter cannot prevent the host's own stale restoration.

This package has no Pi manifest and is not loaded as an extension by itself. It is an independently publishable normal library dependency of packages that use it. Existing consumers are unchanged unless they explicitly opt into an adapter or call the display helper.

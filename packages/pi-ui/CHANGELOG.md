# Changelog

## 1.3.1
### Patch Changes

- 1f586f8: Preserve resumable cancellation when a workflow pauses during successful timeout cleanup, and retain finalized subagent output alongside observer failures. Avoid retaining descendant-owned mouse gestures in bordered components. Track successful writes using final rewritten paths, and distinguish uncertain changes observed during failed calls from confirmed agent modifications while keeping both discoverable in file browsing. Preserve exact filesystem paths and lazy-directory scan state when discovering session-observed changes, including changes injected during an active scan.
- 1f586f8: Forward mouse input through custom UI borders and align shell-editor mouse hit-testing with its rendered prompt. Keep Herdr working through automatic retries and integrate native, title-free UI waiting spans independently of event-bus blocked ownership.
- 1f586f8: - Bound workflow cancellation drains and durably fence unconfirmed cleanup, aborting sibling agents and releasing foreground callers.
  - Await managed timeout cleanup before script continuation and terminal publication.
  - Keep failed retry text and length responses discarded by overflow-compaction retry out of successful subagent fallbacks, while retaining valid pre-compaction and non-retried length output.
  - Account for native prompts spanning reporter activation without dropping out-of-order wait debt.
  - Reconcile settlement after observer-triggered manual compaction with run/session ownership.
  - Preserve clipped overlay hit ranges and native container ancestry for editor autocomplete focus.
  - Reconcile errored writes and edits against pre/post mutation evidence, retaining invocation cwd and releasing evidence when blocked or aborted preflight bypasses tool results.
- 1f586f8: Expand Pi peer support to `^0.84.0 || ^0.85.0`, retaining 0.84 compatibility while admitting 0.85 releases. The previous zero-major caret range excluded Pi 0.85.1. Update existing Pi development dependency pins to 0.85.1.

## 1.3.0
### Minor Changes

- 07350d4: Standardize extension-owned popup surfaces with an idempotent Pi-style border adapter. Native Pi dialogs retain their built-in framing and RPC behavior; custom menus and overlays gain consistent border rules.

## Unreleased

- Add a shared, idempotent border adapter for extension-owned Pi custom UI.

# Changelog

## 1.5.0
### Minor Changes

- 3096585: Qualify the shared TUI Kit 0.69 release against Pi 1.5, synchronizing all consumer ranges. Forward native viewport capture through border adapters and declare it for custom selectors so configured paging reaches the focused list while overlays retain priority.
  
  Settle bordered custom interactions locally on dispose-only host teardown without invoking a stale host completion callback. Preserve consumer-owned cancellation, session fences, draft handling, and accepted-work draining; dispose wrapped components exactly once.

### Patch Changes

- 3096585: Move the development SDK pins to exact Pi 1.5.0 while retaining wildcard host-owned peers and canonical TypeBox 1.3.27. Import the advisor's schema builder directly from TypeBox and report the required `truncated` flag from local Git process adapters. Update SDK fixtures for the new baseline and pi-schema validation diagnostics without changing lifecycle, consent, or model-selection policy.

## 1.4.1
### Patch Changes

- da9ed0f: Document Pi 1.4.0 as the tested host. The packages were requalified against Pi 1.4.0; host behavior statements that still hold now name the range they were verified on.

## 1.4.0
### Minor Changes

- c2fd867: Add the pure `sanitizeDisplayText` display-copy helper and opt-in `withPreservedCustomEditor` context adapter. Neutralize untrusted terminal/bidi controls before styling, and preserve editor writes across custom UI draft restoration without overwriting observable later destination writers. Document the public API's cancellation, pending-work, text-equality, and session-retirement limitations.

## 1.3.3
### Patch Changes

- 3364cc0: Use patched Vitest 4.1.11 for development and regression testing without moving to a new major version. Refresh compatible transitive dependencies to include fixed source-map and brace-expansion releases.
- 3364cc0: Adopt Pi 1.0.4's host-provided dependency contract: declare imported Pi and TypeBox modules as `*` peers rather than installing duplicate runtime modules, and align Pi development pins with the repository's tested 1.0.4 baseline. The wildcard identifies host module ownership; it does not promise compatibility with every Pi version.
- 3364cc0: Preserve native descendant keyboard focus and custom overlay widths. Keep question frames and active controls within the terminal viewport, and distinguish RPC actions from duplicate or reserved option labels. Bound file-browser rows and dispose browser work and polling when interactions close or the session shuts down, without clearing badges on a vetoed session switch.

## 1.3.2
### Patch Changes

- 8190516: Extend the tested Pi host compatibility range through 0.87.x while retaining supported older hosts. Validate the published extensions against Pi 0.87.1 and adapt changed provider, session-context, and lifecycle contracts where necessary.
- 8190516: Add Pi 0.99.1 to the supported host peer ranges while retaining Pi 0.84–0.87 compatibility. Align Pi development dependency pins with 0.99.1 for validation against the new host.

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

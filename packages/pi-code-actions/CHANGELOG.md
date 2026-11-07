# Changelog

## 1.2.10
### Patch Changes

- 3da7832: Tighten package onboarding, consolidate detailed contracts into package-local references where needed, and correct stale documentation without changing runtime behavior or defaults.

## 1.2.9
### Patch Changes

- 3096585: Render Welcome key hints from the host's live bindings, report the inline snippet picker as a native blocking question, and cancel history search below five terminal rows without accepting hidden results or changing the draft.
- 3096585: Move the development SDK pins to exact Pi 1.5.0 while retaining wildcard host-owned peers and canonical TypeBox 1.3.27. Import the advisor's schema builder directly from TypeBox and report the required `truncated` flag from local Git process adapters. Update SDK fixtures for the new baseline and pi-schema validation diagnostics without changing lifecycle, consent, or model-selection policy.

## 1.2.8
### Patch Changes

- da9ed0f: Copy snippets through Pi's own `copyToClipboard` instead of spawning clipboard utilities. `/code copy` now works in remote sessions (OSC 52, including `PI_CLIPBOARD_OSC52=1`), Termux and WSL, keeps Linux clipboard ownership after the copy, and reports Pi's failure reason. A copy pending when the session changes is no longer awaited or reported.
- da9ed0f: Settle a code-actions dialog that the host disposes without closing it. Pi 1.4 resets extension UI on `/reload` by disposing open dialogs; the pending picker or run-output pane is now resolved as cancelled instead of leaving its owner, and session retirement, waiting forever. Host-driven disposal settles locally without splicing Pi's dialog stack during reset, so adjacent foreign dialogs are disposed too; explicit completion still closes synchronously to preserve draft/navigation ordering. Clipboard copying is TUI-only; RPC reports unavailable instead of claiming an OSC52 server-side write reached the client.

## 1.2.7
### Patch Changes

- c2fd867: Own snippet subprocess trees through bounded cleanup on session retirement and normal completion. Retain a POSIX process-group supervisor through TERM/KILL escalation, use best-effort Windows taskkill tree cleanup, and document full-shell policy boundaries. Use Node on PATH for Bun/compiled-Bun hosts rather than evaluating the embedded Pi executable, report the Node prerequisite on launch failure, and bound supervisor readiness to 5 seconds without limiting snippet runtime or filtering inherited security options. Missing readiness or disconnected IPC fails the run and cleans up the owned supervisor. Capture stdout and stderr independently at 64 KiB per stream (128 KiB combined), keep draining after overflow, preserve independent UTF-8 decoding, and report per-stream truncation/loss only when output exceeds the capture limit.

## 1.2.6
### Patch Changes

- 3364cc0: Replace POSIX clipboard pipeline shells with argument-safe exec redirection so cancellation terminates the clipboard utility itself, while preserving private-file cleanup and platform fallbacks.
  
  Omit unchanged dry-run LSP file text and independently bound result details. Spill oversized edits and diagnostics to private files instead of retaining full payloads in session history, preserving compact fix outcome metadata and bounded notices.
- 3364cc0: Close snippet and run-output custom dialogs synchronously when their session ownership retires, before navigation replaces the draft. Cancel action selection and clipboard utilities with the operation signal, ignore retained callbacks, and clean private clipboard files without starting delayed fallbacks.
- 3364cc0: Adopt Pi 1.0.4's host-provided dependency contract: declare imported Pi and TypeBox modules as `*` peers rather than installing duplicate runtime modules, and align Pi development pins with the repository's tested 1.0.4 baseline. The wildcard identifies host module ownership; it does not promise compatibility with every Pi version.
- 3364cc0: Protect clipboard transcripts with private isolated temporary files, decode Kitty printable filter input, and confirm RPC draft replacement with cancellable session/branch ownership so retired confirmations cannot overwrite a replacement draft. Escape unsafe recalled quote controls without changing stored text. Bound LSP tool output with private full-output spills and preserve concurrent per-session status ownership.

## 1.2.5
### Patch Changes

- 8190516: Extend the tested Pi host compatibility range through 0.87.x while retaining supported older hosts. Validate the published extensions against Pi 0.87.1 and adapt changed provider, session-context, and lifecycle contracts where necessary.
- 8190516: Add Pi 0.99.1 to the supported host peer ranges while retaining Pi 0.84–0.87 compatibility. Align Pi development dependency pins with 0.99.1 for validation against the new host.

## 1.2.4
### Patch Changes

- 1f586f8: Expand Pi peer support to `^0.84.0 || ^0.85.0`, retaining 0.84 compatibility while admitting 0.85 releases. The previous zero-major caret range excluded Pi 0.85.1. Update existing Pi development dependency pins to 0.85.1.
- 1f586f8: Cancel RPC question dialogs at the host, serialize LSP fixes with native file edits when the host provides a mutation queue, resolve workspace paths against session context, track successful shell commits, and report terminal-only commands explicitly over RPC.

## 1.2.3
### Patch Changes

- 07350d4: Use the theme's `borderAccent` color for extension-owned outer borders so the popup and welcome-card framing follows the purple Signalridge palette.

## 1.2.2
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

## 1.2.1
### Patch Changes

- b6cf242: Peer dependency ranges now name the versions actually validated against, so an untested host combination fails at install time instead of silently at runtime: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core` move from `"*"` to `^0.84.0`, and `typebox` from `"*"` to `^1.3.11`.
  
  Shared dependencies now carry ONE declared range across every package that uses them, and `bun run check:shared-deps` keeps it that way.
  
  `@narumitw/pi-tui-kit` was declared at three disjoint floors — `^0.54.0`, `^0.51.0`, and `^0.49.1` across nine packages — and the lockfile duly resolved three copies (0.54.0, 0.51.0, 0.49.3) installed side by side. For a shared rendering surface drawing into one terminal inside one host process, that means a theme rendering one way in one extension and another way in the next, with nothing failing at install to say so. All nine now declare `^0.54.0` and the install resolves a single copy. `@sinclair/typebox` likewise converges on `^0.34.50`.
  
  The new check covers `dependencies` and `peerDependencies` and compares range strings rather than their semantics: two ranges that merely overlap are still a finding, because the goal is one intentional answer per dependency rather than an accidental intersection. `devDependencies` are deliberately out of scope — a build tool is not a shared surface, and `pi-subagents` intentionally carries its own toolchain. `docs/package-boundaries.md` documents the Kit as a shared surface for the first time.

## 1.0.0
### Major Changes

- Adopt a unified 1.0.0 across every published package.
  
  The version numbers no longer track their upstream forks individually; from this release each package
  is versioned on its own merit against the Signalridge line, and 1.0.0 is the shared starting point.
  Packages whose behavior changed in this release document that change in their own changeset entries;
  the remainder are re-released unchanged so the whole set shares one baseline.

## [0.1.5] - 2026-05-07

### Changed
- Declare the `@earendil-works` Pi peer and development dependencies used by runtime imports.
- Update Pi extension imports to the new `@earendil-works` namespace.

## 0.1.4 - 2026-02-03
- Add preview image metadata for the extension listing.

## 0.1.2 - 2026-01-26
- Add a src entry point so loading `code-actions/src` works with pi extension discovery.

## 0.1.1 - 2026-01-26
- Move extension source files into `code-actions/src` for clearer organization.

## 0.1.0 - 2026-01-13
- Initial release.

# Changelog

## 1.7.1
### Patch Changes

- da50094: Fix offline-reproduced remote compaction protocol mismatches: normalize fragmented CRLF delimiters only on the successful provider-consumed SSE branch while inspecting original bounded bytes, accept the response.done completion alias, and reject unsuccessful terminal statuses and explicit incomplete events promptly with source cancellation. Preserve exactly-one bounded opaque item validation, abort ownership, deadlines, and existing retries.
  
  Recognize only the exact structured context_window_exceeded / context_length_exceeded wire codes in allowed error-event positions as the fixed remote_context_window_exceeded diagnostic. Unknown codes and arbitrary error text remain generic and private; this adds observability, not overflow recovery.
  
  After validated prior-checkpoint projection, reproduce Pi's resolved canonical system head when the public API is available so later additive tool declarations retain the ordinary request's exact wire layout. Preserve original canonical transcript guards, first-compaction and legacy behavior, and frozen wire validation.
  
  These fixes are demonstrated by offline fixtures and do not establish the cause of an unknown live incident. No extra model round, new retry, checkpoint migration, or relaxed consent/loadout guard is introduced.

## 1.7.0
### Minor Changes

- 4d37546: Cancel compaction before consent, credentials, or native fallback when the effective opaque checkpoint is malformed or incompatible with the active provider, API, or model ID. Keep cancellation effective even if its UI notification or compaction progress status updates throw. Preserve explicit disabled-hook native opt-out and fallback for readable or superseded boundaries; ordinary mismatched requests still expose only the fallback marker and recent messages.
  
  Replace generic compaction-failure diagnostics with closed, source-free reason codes for authentication/unavailable credentials or provider, malformed/incompatible/projected checkpoints, prompt/tool loadout mismatch, locally rejected payload, HTTP response, owned timeout, transport/provider failure, invalid or unsupported compaction SSE, post-response state divergence, and local checkpoint construction. Include only validated integer HTTP status (100–599) from the intercepted Response.status, never error messages/causes, status text, bodies, headers, URLs, credentials, checkpoint contents, history, or arbitrary provider-event text. Preserve a local onPayload rejection code even if the provider swallows its exception; distinguish owned deadlines from caller cancellation and do not reuse an earlier HTTP status after a successful retry.
  
  Opaque cancellation warnings retain preservation semantics and do not suggest the original model for authentication, loadout, or HTTP failures. Add separate fixed non-provider cancellation codes for required/denied canonical consent and same-owner preparation invalidation from branch/leaf or model-route changes. Deliver those best-effort warnings only with UI and a current non-aborted session owner; explicit caller abort and retired session/reload/tree/shutdown owners stay silent, including late consent/auth continuations. UI failures cannot undo cancellation; headless cancellation adds no event payload. Caller cancellation, retired ownership, and denied consent remain cancellation and never grant authorization. No new logging, diagnostic persistence, upload, setting, extra model round, relaxed loadout equality, migration, or retry is added. Codes scope a next manually authorized retry, not a diagnosis or repair of an unknown live backend failure; existing authorization, model identity, opaque-boundary protection, and bounded provider retries are unchanged.
  
  Make persisted checkpoint validation non-throwing for malformed, oversized, deeply nested, or unsupported values so SDK hook-exception recovery cannot native-compact opaque history. Guard and latch throwing ownership callbacks/getters as source-free cancellation. Keep the SDK's exact cancellation sentinel and operation-owned caller/session retirement distinct from unknown manual-menu failures; notification failures remain harmless. Do not confuse the old agent-turn signal, intentionally aborted by SDK manual compaction, with compaction cancellation; real later native failures still receive the fixed source-free notice, including when Compact now interrupts streaming.
  
  Propagate fatal SSE inspection immediately and cancel both provider and source, preserving known invalid-response or closed terminal provider-error event classifications rather than waiting for timeout. Terminal provider failures also abort promptly without awaiting unresolved HTTP-body inspection or iterator closure; already observed safe failures survive the resulting owned abort, while external cancellation and retired ownership retain precedence. Preserve original transport exceptions internally for existing provider retry decisions, while reconstructing only safe diagnostics at the public boundary. Iterate bounded completed output arrays without JavaScript argument-limit dependence; local decoding/validation faults remain distinct from body-read failures. Document Pi 1.0.4 as the automated SDK baseline and Pi 1.3.0 as a separate qualification lane, with no whole-host or live-backend repair claim.
  
  Recognize native additive tool declarations from top-level tools plus ordered developer additional_tools input groups, without weakening fresh owner/session preparation, recorded/registry schema and membership equality, or hidden-tool guards. Require unique names and exact effective names/descriptions; reject redefinitions, malformed/empty groups, other roles or group fields, and unsupported tool-search updates. Freeze and compare the original declaration surface with all serialized schema, format, and strictness metadata rather than a flattened effective set; representation or ordering changes fail closed. Ordinary message/checkpoint content is not retained as tool evidence, and exotic or uncloneable declaration values cannot throw from observation or validation. Add offline native-provider synthetic-wire coverage for additive and flat controls, without credentials, transport, extra model rounds, or changes to provider compatibility flags in runtime code. This scoped capability does not diagnose an unknown live failure.
  
  Allow only narrowly identified Goal bookkeeping appended after Pi's compaction branch snapshot: preserve the complete original source-ID prefix, require the actual leaf to match the live branch tip, and accept only plain `custom` / exact `goal-state` records with fresh unique nonempty IDs and exact parent links. Retain only source IDs in the shared preparation fence; never inspect Goal data. Apply the same fence to preparation ownership and latest canonical state checks at the checked live leaf, preserving prepared/latest prompt, recorded/registry tool/schema, fresh evidence, exact payload, post-response, consent, model-route, and retirement guards. Other records, including unknown custom types and `pi.virtual-model-state`, remain invalidating. Offline native-SDK synthetic-extension regressions cover earlier hooks, authentication, in-flight appends, persisted checkpoint metadata/replay, and negative controls; they do not establish live-session recovery or generic custom-record safety.

## 1.6.0
### Minor Changes

- 44cddda: Keep healthy startup, reload, resume, and new sessions quiet instead of displaying routine experimental warnings. Recall and Analytics retain their experimental lifecycle declarations and documentation without startup notices. Codex Compact shows its short portability warning only when the first remote checkpoint is committed in a UI-capable loaded extension instance; native, failed, and cancelled compactions do not trigger it. Invalid settings, storage failures, fallback failures, and incompatible-checkpoint warnings remain visible. No storage, authorization, checkpoint, or settings schema changes.

## 1.5.0
### Minor Changes

- a4dc1de: Cancel failed remote compaction when the effective boundary is an opaque Codex checkpoint, including malformed or incompatible checkpoints. Native summarization cannot decode its older context; it must not silently supersede it with only the portability warning. Preserve authorized native fallback before the first opaque boundary or after a legitimate native supersession, and keep fixed, credential-safe diagnostics.

## 1.4.0
### Minor Changes

- c2fd867: Require explicit canonical-history authorization before compaction credentials or transport. Default to one-operation TUI consent, cancel without consent (including headless/RPC), and offer a separate persistent settings opt-in. Fence confirmation and dispatch by session/branch ownership, use the credential-resolved destination, and document ordinary request-filter and service-tier differences. Add offline Pi 1.0.4/Codex serializer privacy, persistence, replay, and destination regression fixtures. Keep manual compaction-failure notifications credential-free even when native fallback errors echo secrets, suppress stale callback notifications after navigation, and clarify the extension-owned notification boundary.

### Patch Changes

- Updated dependencies [c2fd867]
  - @signalridge/pi-ui@1.4.0

## 1.3.3
### Patch Changes

- 3364cc0: Prevent provider, transport, inspection, and authentication errors from exposing credentials in remote compaction errors or native fallback warnings. Preserve cancellation with a safe AbortError and omit raw error causes.
  
  Finish SSE inspection at the terminal response and coordinate tee cancellation. Apply an extension-owned deadline across the entire operation, including stalled injected response bodies, with abort and timer cleanup.
  
  Use full retained-message provenance on canonical Pi hosts where recovery omissions are persisted before compaction. Limit the runtime-tail compatibility bridge to legacy projectionless hosts, and document conservative native fallback for prepareLoadout/codemode tool rewrites.
- 701382c: Require fresh agent-context preparation and matching provider declarations before accepting transformed tool descriptions. Cached provider callbacks cannot approve unsent registry edits, hidden declarations use native compaction, and remote serialization must match frozen wire tools before transport. Preserve unchanged codemode-on compaction/replay and reconcile the documented limitations.
- 3364cc0: Include credential resolution in the Codex compaction deadline and promptly stop waiting on cancellation without interrupting host-owned token persistence. Preserve configured-package inventory for default-autoload exclusion-only resource filters.
- 69a5bed: Recognize already-dispatched model-facing tool descriptions transformed by codemode or other loadout hooks instead of comparing them with raw registry descriptions. Preserve native fallback for unobserved transformations and genuine prompt, registry, schema, or branch changes, including changes during remote requests. Scope dispatch evidence to the active session and clear it on reload or tree navigation.
- 3364cc0: Adopt Pi 1.0.4's host-provided dependency contract: declare imported Pi and TypeBox modules as `*` peers rather than installing duplicate runtime modules, and align Pi development pins with the repository's tested 1.0.4 baseline. The wildcard identifies host module ownership; it does not promise compatibility with every Pi version.
- Updated dependencies [3364cc0]
- Updated dependencies [3364cc0]
- Updated dependencies [3364cc0]
  - @signalridge/pi-ui@1.3.3

## 1.3.2
### Patch Changes

- 8190516: Normalize Codex compaction requests for Pi 0.87 providers without prepending a duplicate system prompt or restoring removed tools when the session already carries system updates; retain the original context path on older Pi hosts. Fall back to native compaction if live prompt or tool changes have not yet reached the persisted transcript, or if the prompt, tool set, or active session branch diverges while the remote request is in flight. Fingerprint only the projected conversation messages Pi actually retains after compaction: system updates are snapshotted onto the compaction entry, while context-edited replacements and raw cut-point identities still replay correctly across repeated compaction and reload.
- 8190516: Extend the tested Pi host compatibility range through 0.87.x while retaining supported older hosts. Validate the published extensions against Pi 0.87.1 and adapt changed provider, session-context, and lifecycle contracts where necessary.
- 8190516: Add Pi 0.99.1 to the supported host peer ranges while retaining Pi 0.84–0.87 compatibility. Align Pi development dependency pins with 0.99.1 for validation against the new host.
- Updated dependencies [8190516]
- Updated dependencies [8190516]
  - @signalridge/pi-ui@1.3.2

## 1.3.1
### Patch Changes

- 1f586f8: Include real tool-result text in bounded side-question context, select remote checkpoints at Pi's effective compaction boundary, honor the public agent directory, restore branch-owned stamp state on tree navigation, and preserve commit evidence through retries until agent settlement.
- 1f586f8: Preserve Codex opaque checkpoints across Pi's retry-only assistant-tail removal using optional, fingerprint-verified version-1 proof plus explicit lifecycle provenance. Preserve that provenance across same-runtime reload without confusing a new identical assistant response with the persisted tail; persisted rebuilds reset it and unknown provenance fails closed. Bound BTW context and tool-argument construction, including suffix-key storage for wide JSON-shaped objects (enumeration remains linear). Balance out-of-order native UI waiting notifications without affecting manual blocked ownership. Foreground workflow cancellation waits for exact-owner quiescence even when stop is unavailable or rejects after reconciliation already stopped the child, including cancelled spawn allocation recovery; unconfirmed cleanup becomes durably non-resumable with a diagnostic retaining any stop error. Background execution remains detached.
  
  These are corrective changes: existing checkpoint fields, exports, and cross-extension protocols remain compatible, so no protocol or major-version bump is required.
- 1f586f8: Expand Pi peer support to `^0.84.0 || ^0.85.0`, retaining 0.84 compatibility while admitting 0.85 releases. The previous zero-major caret range excluded Pi 0.85.1. Update existing Pi development dependency pins to 0.85.1.
- d9219d4: Converge every README on one house style: plain sentence-case headings, no
  decorative emoji.
  
  Ten packages carried an emoji heading scheme inherited from their upstream
  forks while the other nineteen used plain headings, so the same monorepo
  rendered as two unrelated projects on npmjs.com. Headings are now emoji-free
  and titles are sentence case.
  
  Also removes the `Keywords` section from those ten. It duplicated each
  package's `package.json` `keywords` field, which is what npm actually indexes,
  and no plain-style README carried one. `Installation` is now `Install`
  everywhere.
  
  Headings that were Title Case are sentence case too, so one convention now
  covers the whole monorepo. Existing in-page anchor links are unaffected:
  GitHub lowercases heading slugs already.
  
  Documentation only — no runtime change.
- Updated dependencies [1f586f8]
- Updated dependencies [1f586f8]
- Updated dependencies [1f586f8]
- Updated dependencies [1f586f8]
  - @signalridge/pi-ui@1.3.1

## 1.3.0
### Minor Changes

- 07350d4: Standardize extension-owned popup surfaces with an idempotent Pi-style border adapter. Native Pi dialogs retain their built-in framing and RPC behavior; custom menus and overlays gain consistent border rules.

### Patch Changes

- Updated dependencies [07350d4]
  - @signalridge/pi-ui@1.3.0

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

### Patch Changes

- Bound the resume lineage walk's skip window by the checkpoint's own creation time as well as the rendered summary's timestamp, so a session file whose entry timestamp is later than the checkpoint — hand-edited, migrated, or resumed across a clock skew — can no longer drop a native compaction summary the opaque replacement does not cover. The injected checkpoint marker also always carries a finite timestamp, and an impossible lineage is rejected before hashing the rest of the context.
- Keep re-expanding the opaque Codex checkpoint after a session resume by tolerating replayed older compaction summaries interleaved with the retained messages, instead of silently dropping the remote history.

## Unreleased

- Accept legacy `@narumitw/pi-codex-compact` checkpoint summaries while validating checkpoint payloads and kept-message lineage.
- Skip malformed/native compaction entries when selecting the newest valid Codex checkpoint instead of masking an older recoverable checkpoint.
- Replay legacy `@narumitw/pi-codex-compact` checkpoint markers after reload by accepting and normalizing canonical and legacy marker variants.

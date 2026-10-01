# @signalridge/pi-btw

## 1.4.0
### Minor Changes

- 8190516: **Privacy behavior change:** Independent `/btw` requests no longer include the parent transcript or system prompt by default. Pi's parent `context` hooks can redact provider-visible messages, but their result is not exposed to extensions; forwarding the raw session projection bypassed those redactions. Side questions now send only the explicit question and their own successful side-thread turns. To include **unfiltered** parent history for one question, use `--with-parent=provider/model-id` before that question, naming the actual selected physical model. Each follow-up needs a new opt-in to read the parent again; mismatched, virtual, or auth-endpoint-overridden destinations fail closed. Once parent history has been shared, the side thread is bound to that physical model and effective endpoint, so later provider/model/endpoint switches require a fresh side thread rather than relaying an answer that may echo private parent data. Context-dependent questions without an opt-in will need details supplied in the question or the explicit destination-bound prefix.

### Patch Changes

- 8190516: Normalize side-thread requests before calling Pi 0.87 providers while retaining legacy Context requests on older Pi hosts and preserving the auth-resolved endpoint. When a question explicitly opts in to unfiltered parent history, build its snapshot from Pi's session projection (which honors persisted edits but not request-time privacy hooks), refresh it when the first provider request starts so intervening edits are honored, then keep that snapshot for follow-ups. Fence stale session requests and bring-to-main actions, include bounded compaction and branch summaries plus model-visible custom/Bash messages in order, and retain the raw-branch fallback on older Pi hosts.
- 8190516: Close an open /btw menu at Pi's pre-switch and pre-tree boundaries, before Pi restores its saved editor text; keep canceled boundaries' live drafts and fence stale menu, side-thread, and fullscreen continuations from replacement sessions.
- 8190516: Extend the tested Pi host compatibility range through 0.87.x while retaining supported older hosts. Validate the published extensions against Pi 0.87.1 and adapt changed provider, session-context, and lifecycle contracts where necessary.
- 8190516: Add Pi 0.99.1 to the supported host peer ranges while retaining Pi 0.84–0.87 compatibility. Align Pi development dependency pins with 0.99.1 for validation against the new host.
- 8190516: Preserve the current main-editor text synchronously when a committed session transition closes the /btw fullscreen UI. Pi restores the outgoing editor snapshot inside the custom UI's close callback; this fix retains a destination draft written by an earlier extension's session handler without overwriting a later handler's draft or resurrecting text after a canceled transition.
- 8190516: Route Pi 0.99.1 virtual models through the public model registry for side questions, resolving the physical target and credentials at request time. Retain direct provider streaming for physical models on older Pi hosts, and report an explicit error when virtual routing is unavailable.
- Updated dependencies [8190516]
- Updated dependencies [8190516]
  - @signalridge/pi-ui@1.3.2

## 1.3.2
### Patch Changes

- e939fa0: Fix Pi 0.85.1 tool-approval argument forwarding, ambient-auth and credential-specific model routing, and cross-platform workspace session validation.

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

### Minor Changes

- Add session- and branch-scoped, in-memory resumable side threads with a bounded searchable picker, stable IDs, activity ordering, and thread-local thinking levels while keeping direct questions fresh and avoiding disk persistence.

## 0.49.7

### Patch Changes

- 3f33860: Run side threads in a dedicated full-screen TUI so mouse-drag copying stays stable while the main agent continues producing output in the background.
- 2a2c9c1: Queue Pi-style steering questions while a side-thread answer is running, process them one at a time without touching the main conversation, and report malformed side-model responses without hanging the side UI.

## 0.49.6

### Patch Changes

- a4b44ee: Route side-question completions through Pi's effective runtime provider so custom provider APIs work.

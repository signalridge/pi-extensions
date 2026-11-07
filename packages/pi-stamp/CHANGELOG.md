# Changelog

## 1.4.1
### Patch Changes

- 3da7832: Tighten package onboarding, consolidate detailed contracts into package-local references where needed, and correct stale documentation without changing runtime behavior or defaults.

## 1.4.0
### Minor Changes

- 3096585: Qualify the shared TUI Kit 0.69 release against Pi 1.5, synchronizing all consumer ranges. Forward native viewport capture through border adapters and declare it for custom selectors so configured paging reaches the focused list while overlays retain priority.
  
  Settle bordered custom interactions locally on dispose-only host teardown without invoking a stale host completion callback. Preserve consumer-owned cancellation, session fences, draft handling, and accepted-work draining; dispose wrapped components exactly once.
- 3096585: Preserve optional native cost provenance in assistant metadata and label provider, estimated, and unknown totals truthfully. Retain the historical public cost field and readable legacy entries without rewriting history or repricing usage.

### Patch Changes

- 3096585: Move the development SDK pins to exact Pi 1.5.0 while retaining wildcard host-owned peers and canonical TypeBox 1.3.27. Import the advisor's schema builder directly from TypeBox and report the required `truncated` flag from local Git process adapters. Update SDK fixtures for the new baseline and pi-schema validation diagnostics without changing lifecycle, consent, or model-selection policy.
- 3096585: Requalify optional cost attribution when the active native branch leaf changes, so duplicate, malformed or overflowing annotations cannot leave a stale known-origin label on mounted or fresh stamp renderers. Preserve frozen v4 history and successful source/tool ordering.
- 3096585: Keep the frozen version-4 stamp usage shape readable after rollback. Store optional cost origin in separately versioned, branch-local annotations referencing exact native stamp IDs; overlay validated origin only for display. Failed or ambiguous annotation writes leave the source stamp valid and attribution unknown, without repricing or rewriting history.
- 3096585: Reuse unchanged, uncoloured stamp labels, metadata and wrapped rows during transcript repaints with bounded value-sensitive caches. Keep theme colouring, native-branch cost attribution and the existing lazy OS-default refresh live, and clear cached work on component invalidation or session retirement. Retry failed label formatting without caching an empty result, observe property enumerability changes and bypass accessor-backed snapshots without extra getter calls.
- Updated dependencies [3096585]
- Updated dependencies [3096585]
  - @signalridge/pi-ui@1.5.0

## 1.3.5
### Patch Changes

- da9ed0f: Develop and test against Pi 1.4.0. The package's SDK and rendering tests now run on the new baseline host, including the 1.2 run-start and 1.3 dialog-stack changes; no runtime behavior changed.
- Updated dependencies [da9ed0f]
  - @signalridge/pi-ui@1.4.1

## 1.3.4
### Patch Changes

- c00f9f9: Selectively port upstream compatibility fixes while retaining local safety behavior:
  
  - Honor live terminal color and hyperlink capabilities, and keep plain PR references inline without duplication.
  - Bound timestamp formatter reuse and refresh resolved system locale/time-zone defaults after environment changes.
  - Embed native working status only in the history extension's fallback editor.
  - Give each side thread an independent provider session identity that survives in-memory follow-ups and resume.

## 1.3.3
### Patch Changes

- 3364cc0: Preserve pre-request route failures and finalized physical dispatch attribution in analytics, normalize skill read paths, and account for direct tool usage and dispatched thinking levels with a rebuilt usage cache and Pi's public agent-directory resolver. Capture sanitized terminal deferred assistant stamps and use finalized tool outcomes while retaining execution timings.
- 3364cc0: Adopt Pi 1.0.4's host-provided dependency contract: declare imported Pi and TypeBox modules as `*` peers rather than installing duplicate runtime modules, and align Pi development pins with the repository's tested 1.0.4 baseline. The wildcard identifies host module ownership; it does not promise compatibility with every Pi version.
- Updated dependencies [3364cc0]
- Updated dependencies [3364cc0]
- Updated dependencies [3364cc0]
  - @signalridge/pi-ui@1.3.3

## 1.3.2
### Patch Changes

- 8190516: Extend the tested Pi host compatibility range through 0.87.x while retaining supported older hosts. Validate the published extensions against Pi 0.87.1 and adapt changed provider, session-context, and lifecycle contracts where necessary.
- 8190516: Add Pi 0.99.1 to the supported host peer ranges while retaining Pi 0.84–0.87 compatibility. Align Pi development dependency pins with 0.99.1 for validation against the new host.
- 8190516: Ignore Pi 0.99 nested tool execution events when reserving the bounded tool-stamp observation budget, so a later top-level sibling still receives its timestamp and outcome stamp.
- Updated dependencies [8190516]
- Updated dependencies [8190516]
  - @signalridge/pi-ui@1.3.2

## 1.3.1
### Patch Changes

- 1f586f8: Include real tool-result text in bounded side-question context, select remote checkpoints at Pi's effective compaction boundary, honor the public agent directory, restore branch-owned stamp state on tree navigation, and preserve commit evidence through retries until agent settlement.
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

## Unreleased

- Refresh package metadata and Pi namespace compatibility.

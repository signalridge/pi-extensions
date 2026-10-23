# @signalridge/pi-lsp

## 1.2.8
### Patch Changes

- c00f9f9: Match diagnostics and waiters across equivalent file URL encodings, including Windows drive casing, without changing non-file URI identity. Cancel and drain complete session-owned diagnostics and fix invocations during shutdown/replacement, prevent cancelled continuations and queued writes, and guard stale status contexts while preserving client leases and mutation freshness checks.

## 1.2.7
### Patch Changes

- a4dc1de: Revalidate workspace containment, file identity, and snapshot bytes before writing LSP fixes so external saves, replacements, and escaping symlink retargets detected during code-action computation are preserved. Keep native mutation-queue serialization and document the remaining external-writer race.

## 1.2.6
### Patch Changes

- c2fd867: Retain ownership of language-server subprocesses until confirmed closure, escalating TERM-resistant children to SIGKILL after a bounded grace period. Await cleanup after shutdown, cancellation, and protocol failure, and isolate restart cleanup from the next child. Failed escalation reports a bounded cleanup failure without claiming reaping or releasing ownership; restart remains blocked until close. Preserve an existing tool-call error when cleanup also fails. Bound post-KILL close confirmation independently even when signalling returns true, and retain unconfirmed client leases across diagnostics/fix runner invocations for the same actual adapter/launcher/environment and workspace root. Rescan every current owner synchronously after waits before admitting a lease, without blocking concurrent active clients. Canonicalize root and launcher aliases and hash the effective inherited-plus-overridden environment snapshot used for spawning so equivalent calls cannot bypass cleanup guards or retain secrets in lease keys. Release leases only on confirmed close; unrelated adapters, environments, and roots remain available.

## 1.2.5
### Patch Changes

- 3364cc0: Replace POSIX clipboard pipeline shells with argument-safe exec redirection so cancellation terminates the clipboard utility itself, while preserving private-file cleanup and platform fallbacks.
  
  Omit unchanged dry-run LSP file text and independently bound result details. Spill oversized edits and diagnostics to private files instead of retaining full payloads in session history, preserving compact fix outcome metadata and bounded notices.
- 3364cc0: Adopt Pi 1.0.4's host-provided dependency contract: declare imported Pi and TypeBox modules as `*` peers rather than installing duplicate runtime modules, and align Pi development pins with the repository's tested 1.0.4 baseline. The wildcard identifies host module ownership; it does not promise compatibility with every Pi version.
- 3364cc0: Protect clipboard transcripts with private isolated temporary files, decode Kitty printable filter input, and confirm RPC draft replacement with cancellable session/branch ownership so retired confirmations cannot overwrite a replacement draft. Escape unsafe recalled quote controls without changing stored text. Bound LSP tool output with private full-output spills and preserve concurrent per-session status ownership.

## 1.2.4
### Patch Changes

- 8190516: Extend the tested Pi host compatibility range through 0.87.x while retaining supported older hosts. Validate the published extensions against Pi 0.87.1 and adapt changed provider, session-context, and lifecycle contracts where necessary.
- 8190516: Add Pi 0.99.1 to the supported host peer ranges while retaining Pi 0.84–0.87 compatibility. Align Pi development dependency pins with 0.99.1 for validation against the new host.
- 8190516: Keep a bounded UTF-8-safe tail of language-server stderr in memory and error messages without copying the entire tail for every chunk. Ignore output and exit events from a superseded server when a client restarts, and clear its partial JSON-RPC frame and cached diagnostics before opening the replacement.

## 1.2.3
### Patch Changes

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
- 1f586f8: Cancel RPC question dialogs at the host, serialize LSP fixes with native file edits when the host provides a mutation queue, resolve workspace paths against session context, track successful shell commits, and report terminal-only commands explicitly over RPC.

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

## 0.49.4

### Patch Changes

- 9b96a71: Use Pi's host-provided coding-agent and TypeBox runtimes instead of installing duplicate copies.

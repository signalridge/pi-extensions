---
"@signalridge/pi-agent-guidance": patch
"@signalridge/pi-analytics": patch
"@signalridge/pi-btw": patch
"@signalridge/pi-code-actions": patch
"@signalridge/pi-codex-compact": patch
"@signalridge/pi-files-widget": patch
"@signalridge/pi-github-pr": patch
"@signalridge/pi-goal": patch
"@signalridge/pi-gpt-fast": patch
"@signalridge/pi-herdr-state": patch
"@signalridge/pi-input-history": patch
"@signalridge/pi-input-prefix": patch
"@signalridge/pi-lsp": patch
"@signalridge/pi-plan-mode": patch
"@signalridge/pi-ralph-wiggum": patch
"@signalridge/pi-recall": patch
"@signalridge/pi-session-recap": patch
"@signalridge/pi-stamp": patch
"@signalridge/pi-statusline": patch
"@signalridge/pi-tab-status": patch
"@signalridge/pi-usage-extension": patch
"@signalridge/pi-welcome": patch
"@signalridge/pi-workflows": patch
"@signalridge/pi-worktime": patch
"@signalridge/pi-worktree": patch
---

Peer dependency ranges now name the versions actually validated against, so an untested host combination fails at install time instead of silently at runtime: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core` move from `"*"` to `^0.84.0`, and `typebox` from `"*"` to `^1.3.11`.

Shared dependencies now carry ONE declared range across every package that uses them, and `bun run check:shared-deps` keeps it that way.

`@narumitw/pi-tui-kit` was declared at three disjoint floors — `^0.54.0`, `^0.51.0`, and `^0.49.1` across nine packages — and the lockfile duly resolved three copies (0.54.0, 0.51.0, 0.49.3) installed side by side. For a shared rendering surface drawing into one terminal inside one host process, that means a theme rendering one way in one extension and another way in the next, with nothing failing at install to say so. All nine now declare `^0.54.0` and the install resolves a single copy. `@sinclair/typebox` likewise converges on `^0.34.50`.

The new check covers `dependencies` and `peerDependencies` and compares range strings rather than their semantics: two ranges that merely overlap are still a finding, because the goal is one intentional answer per dependency rather than an accidental intersection. `devDependencies` are deliberately out of scope — a build tool is not a shared surface, and `pi-subagents` intentionally carries its own toolchain. `docs/package-boundaries.md` documents the Kit as a shared surface for the first time.
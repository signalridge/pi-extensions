# @signalridge/pi-goal

## 1.4.0
### Minor Changes

- 07350d4: Standardize extension-owned popup surfaces with an idempotent Pi-style border adapter. Native Pi dialogs retain their built-in framing and RPC behavior; custom menus and overlays gain consistent border rules.

### Patch Changes

- Updated dependencies [07350d4]
  - @signalridge/pi-ui@1.3.0

## 1.3.1
### Patch Changes

- f714ea0: Publish the package versions already prepared by the previous release transition after its first publish attempt was blocked before npm publication.

## 1.3.0
### Minor Changes

- b6cf242: New `goal_wait` tool: a goal that depends on something outside the session — CI finishing, a review landing, a reply arriving — can now say so. Without it the model either burns continuation turns re-checking or reports a blocker that is not one; `goal_wait` records *why* it is waiting, pauses the goal, and either waits for the next real message or wakes itself on a deadline.
  
  It reuses the existing `paused` state rather than adding a fourth one, so every resume path, restore path, and status surface already handles it, and the deadline resumes through the same code as `/goal resume` (tool-policy preparation, recovery clearing, prompt delivery) rather than a second, lesser resume. Requests below 10s are clamped rather than refused — the model's intent ("wait, then check") is right even when its number makes a polling loop — and the reply says when a number was raised. The wake-up re-checks at fire time that the goal is still the paused, active one, and a generation counter keeps an already-in-flight callback from waking a goal that was cleared microseconds earlier.
  
  `toolVisibility` now defaults to `"after-first-goal"` instead of `"always"`.
  
  `goal_complete` and `goal_blocked` are meaningless without an active goal, so in a session that never runs `/goal` — the overwhelming majority — their definitions and prompt guidelines were pure context cost paid on every request. They are now withheld until the first accepted `/goal` activation, and a session that restores an unfinished goal reveals them at startup as before.
  
  Nothing else changes: the `"after-first-goal"` machinery is unchanged, missing and invalid settings both land on the new default (an unreadable settings file must not be a way to get the always-on behaviour), and `"always"` remains available for anyone who wants a tool schema that is identical from session startup.
  
  Reload Pi after changing the setting, as before.

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

## 0.49.7

### Patch Changes

- fa9c938: Reduce idle startup imports by loading Goal presentation, Chat networking and UI, and Sync operation-specific modules only when their routes require them.

## 0.49.6

### Patch Changes

- 6f98395: Sanitize terminal-rendered Goal text, bound terminal-tool inputs and outputs, report malformed commands in headless modes, and keep runtime smoke coverage on public Pi APIs.

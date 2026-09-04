# pi-worktree — safe Git worktree management for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-worktree)](https://www.npmjs.com/package/@signalridge/pi-worktree) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@signalridge/pi-worktree` adds one interactive `/worktree` command for common Git worktree operations and Pi workspace switching.

Pi cannot change its parent process working directory with `cd`. This extension performs the safe equivalent: it prepares a Pi session whose cwd is the selected worktree and switches to that session, preserving the current conversation when it has already been persisted.

This package is the full interactive worktree manager. It is publishable and stable, and opt-in: install it only if your project allows git worktrees. Some repositories forbid them outright — a worktree placed inside the source tree can be picked up by tooling that scans the tree, so check your repository's own guidance before enabling it.

## Features

- Shows compact main, linked, current, detached, locked, and prunable state in worktree selectors.
- Creates a new branch worktree or attaches an existing unoccupied local branch.
- Rejects occupied targets and unresolvable symbolic-link ancestors before Git can create a branch.
- Suggests `~/.worktrees/<main-worktree-name>/<branch>` by default and lets the user configure the root interactively.
- Optionally switches Pi into a newly created worktree while continuing the current conversation.
- Switches among existing registered worktrees through Pi's public session replacement API.
- Removes unlocked, non-current linked worktrees and preserves their branches.
- Refuses removal when tracked, untracked, manually index-flagged, submodule, or current unreachable detached-commit data may be lost.
- Refuses removal when ignored local data such as `node_modules/` is present; remove it manually before retrying.
- Names recovery-only administrative commits in the destructive confirmation instead of making ordinary rebase/reset history block cleanup forever.
- Always previews stale metadata before pruning it and revalidates the preview after confirmation.
- Runs Git through argv-based subprocess calls, without interpolating user input into shell commands.

## Install

```bash
pi install npm:@signalridge/pi-worktree
```

Try without installing permanently:

```bash
pi -e npm:@signalridge/pi-worktree
```

Try this package locally from the repository root:

```bash
just try worktree
# or: pi -e ./packages/pi-worktree
```

## Usage

Run the command without arguments:

```text
/worktree
```

Choose one action:

- **Add worktree** — enter a branch, optional start point, and optional path; the confirmation names the branch, base ref, full base commit, and target path before creation, then optionally switch.
- **Switch worktree** — select another existing worktree and continue this Pi conversation there.
- **Remove worktree** — remove a linked worktree without deleting its branch; local ignored data must be removed first.
- **Prune stale metadata** — inspect Git's dry-run output, then optionally run the matching prune.
- **Configure worktree root** — set a machine-local default root or submit a blank value to restore `~/.worktrees`.

The standard root menu shows the registered count, current path, effective worktree root, its source,
and any settings warning. Escape closes it. `/worktree` intentionally does not accept text
subcommands or expose argument autocomplete. Every change is initiated and confirmed through TUI or
RPC dialogs; print and JSON modes reject the command observably. Operation-specific branch/path
inputs, worktree identity selectors, preflight previews, and destructive confirmations remain
extension-owned because they carry Git safety and commit-aware revalidation.

## Add defaults

For a new branch, the current symbolic branch is the default start point. If Pi is running from detached HEAD, the command requires an explicit commit-ish. Git must resolve the start point to exactly one commit.

The default root is `~/.worktrees`, where `~` is Node's platform home directory. Suggestions use the registered main worktree's directory name, not the current linked-worktree cwd:

```text
main worktree: /home/user/workspace/project
branch:        feat/login
root:          /home/user/.worktrees
suggested:     /home/user/.worktrees/project/feat-login
```

On Windows, the equivalent default is such as `C:\Users\Alice\.worktrees`. Branch `/` characters become `-`. The extension does not add hashes or collision suffixes: if two normalized paths collide or the target already exists, Add stops before Git mutation.

Leave the path input blank to accept the suggestion. A custom absolute path is used directly; a custom relative path is resolved from the current Pi cwd. The target itself must not exist, and its nearest existing ancestor must resolve without a broken or looping symbolic link. Existing registered worktrees are never moved when this default changes.

The MVP does not expose `--force`, `-B`, `--detach`, `--orphan`, or lock options.

## Worktree root settings

The machine-local user settings file is:

```text
<getAgentDir()>/pi-worktree.json
```

For a default Pi installation this is typically `~/.pi/agent/pi-worktree.json`. Configure it through **Configure worktree root** or edit it manually:

```json
{
  "worktreeRoot": "~/worktrees"
}
```

`worktreeRoot` accepts `~`, a home-prefixed path such as `~/worktrees`, or a native-platform absolute path. It does not expand `$VAR`, `%VAR%`, or other shell syntax. Empty, relative, NUL-containing, non-string, and invalid paths are rejected. There is no project override or extension-specific environment variable.

A missing `worktreeRoot` uses `~/.worktrees`; the settings file is created only by a successful interactive change. Submitting a blank value in the interactive action removes the override. Within one Pi process, queued saves run in invocation order, reread the latest valid document immediately before merging `worktreeRoot`, and preserve concurrent unknown-field edits. Settings reload on every `session_start`, including `/reload` and workspace replacement; a successful interactive save applies immediately to the next Add flow.

Malformed or invalid settings are warned about but never overwritten, including an invalid edit made while a settings action is open. An initial failure uses `~/.worktrees`; a later failure retains the last valid effective root. Interactive configuration remains blocked until the invalid file is fixed manually. Failed publication leaves the prior file and effective runtime root unchanged, and the save queue remains usable after rejection.

## Pi workspace switching

Switching uses Pi's public `SessionManager` and `ctx.switchSession()` APIs:

1. The command waits for Pi to become fully idle so the current assistant/tool results are persisted.
2. A linear persisted session is forked into the target worktree. If `/worktree` currently points at an older branch, the documented session entries for that active branch are written to the target instead, so switching cannot jump to a newer serialized leaf.
3. Pi tears down the old cwd-bound runtime and creates the target runtime.
4. The extension reports success only through the fresh replacement-session context.

If the current session is completely empty, the extension creates a valid empty Pi session for the target. If the current session is ephemeral (`--no-session`), the extension copies its active conversation branch into a persisted target session so the workspace switch does not lose context.

A successfully created Git worktree is never rolled back merely because Pi session switching fails. Re-run `/worktree` and choose **Switch worktree** after resolving the reported Pi/session issue.

## Safety boundaries

- The main worktree and current worktree cannot be removed.
- Locked or stale worktrees cannot be removed through this extension.
- Dirty, untracked, initialized-submodule, and intentional `assume-unchanged`/`skip-worktree` index state causes removal to fail closed. Sparse-checkout-managed `skip-worktree` entries outside the active sparsity rules are allowed when Git's rule checker can confirm them; clear other intentional index flags before removing the worktree.
- Ignored files and directories block removal and are listed in the refusal; remove them manually before retrying.
- A detached HEAD must be reachable from a local branch, tag, or remote ref before removal or prune.
- Removal and prune inspect reflogs, pseudorefs, per-worktree refs, and `FETCH_HEAD`. Historical commits reachable only through this administrative recovery state are listed by full OID in the destructive confirmation; approval removes those recovery pointers, so Git may later garbage-collect the commits. Create a branch or tag instead when any listed commit should survive.
- Staged-only administrative index state, a missing attached branch ref, or an unreachable current detached HEAD still blocks prune without an override.
- Removal never deletes a branch and never uses `--force`.
- Worktree paths, branches, and lock reasons are stripped of terminal control characters and bidirectional overrides before display, so a crafted branch name cannot make the menu read as a different worktree than the one a removal acts on. Line separators become a single space rather than disappearing, so multi-line Git output in a destructive confirmation never welds two records into one.
- Safe removal invokes argv-based `git worktree move <path> <quarantine>` before validation, moves the real tree to a private tombstone, reserves the registered path with an exclusive non-directory entry, and uses an isolated `git worktree prune --expire now` for metadata only. Failed pre-removal recovery uses the inverse Git move and retains an unsafe quarantine; production runtime never invokes a shell, `rm`, or `rm -rf`.
- Prune always runs `git worktree prune --dry-run --verbose` before confirmation, inspects candidates omitted from porcelain, rechecks the exact preview and recovery-risk set after confirmation, and uses Git's default expiry. Remove likewise rechecks worktree identity, filesystem path identity, inventory immediately before deletion, administrative path, and the approved recovery-risk set before mutation.
- Add resolves the base commit before confirmation — for a new branch from the requested start point, and for an existing branch from `refs/heads/<branch>` so a same-named tag cannot stand in — shows branch, base ref, full base OID, and path in the confirmation, and then re-reads `git worktree list`, the local branch ref, and the base OID under the worktree mutation lock immediately before `git worktree add`. A base that moved, a branch that was created, deleted, or checked out elsewhere, or a path that was claimed while the dialog was open refuses the add instead of creating a worktree from a base the user did not approve; the message names both OIDs so you can re-run Add to approve the new base. The created worktree is verified against the approved branch ref and base OID.
- The extension does not expose commit, push, rebase, repair, user-requested move, lock, or unlock worktree actions.

Use Git directly when you intentionally need force removal, branch deletion, custom prune expiry, detach/orphan creation, move, repair, lock, or unlock behavior.

## Requirements and limits

- Git must be installed and the current Pi cwd must be inside a non-bare Git worktree.
- The command requires a UI-capable Pi mode; print and JSON modes cannot drive its dialogs.
- Project trust and cwd-bound extension/resource loading during a switch remain owned by Pi.
- The extension registers no LLM tool, background watcher, project settings, or statusline item.

## Package layout

```text
packages/pi-worktree/
├── src/
│   ├── index.ts
│   ├── command.ts
│   ├── git.ts
│   ├── session.ts
│   ├── settings.ts
│   └── worktree.ts
├── test/
│   ├── command.test.ts
│   ├── git.integration.test.ts
│   ├── git.test.ts
│   ├── remove-ignored-command.test.ts
│   ├── session.test.ts
│   └── settings.test.ts
├── package.json
├── README.md
├── LICENSE
└── tsconfig.json
```

## License

MIT

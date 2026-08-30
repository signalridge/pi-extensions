---
"@signalridge/pi-gpt-fast": patch
"@signalridge/pi-goal": patch
"@signalridge/pi-ralph-wiggum": patch
"@signalridge/pi-welcome": patch
"@signalridge/pi-input-history": patch
"@signalridge/pi-subagents": patch
---

Durability and containment fixes found in a repository-wide scan.

`pi-gpt-fast` rewrote pi's own global `settings.json` with a plain
`writeFileSync`. That file is shared with pi and every other extension, and this
one is the only writer of it; a torn write would have left the user with no pi
configuration at all rather than just no gpt-fast setting. It now writes a temp
file and renames, matching every other settings writer in the repository.
`pi-goal` gets the same treatment for its cross-project goal state file, which
its own settings module already did.

`pi-ralph-wiggum` resolved `/ralph start <path>` straight against the session
cwd, so `../../notes.md` would create directories and a file outside the project
the user opened — silently, before the loop started. This extension drives long
unattended loops, so that command is as likely to come from a model as from a
person. Task-file paths are now required to stay inside the workspace, on the
command, on the `ralph_start` tool, and on the paths read back out of persisted
state, so a state file written earlier or edited by hand cannot pull a file in
from outside either.

The containment test canonicalizes both sides before comparing, because a purely
lexical one is defeated by a symlink: every segment of `linked/plan.md` reads as
inside the workspace when `linked` is a door out of it. `realpathSync` throws on
a path that does not exist yet — the ordinary case, since `start` is usually
creating the file — so it resolves the deepest existing ancestor and re-attaches
the not-yet-created suffix, which cannot itself be a link. The traversal test
matches a `..` segment rather than a `..` prefix; the prefix form also rejected
`..notes.md`, an ordinary filename sitting in the workspace.

Every remaining bare `catch {}` now says why the error is safe to drop, matching
the convention the rest of the repository already follows.

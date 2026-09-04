---
"@signalridge/pi-subagents": patch
"@signalridge/pi-workflows": patch
"@signalridge/pi-worktree": patch
"@signalridge/pi-plan-mode": patch
"@signalridge/pi-goal": patch
"@signalridge/pi-usage-extension": patch
"@signalridge/pi-welcome": patch
---

Correct shipped documentation that contradicted the code or the manifest.

- `pi-subagents`: the summary line still advertised protocol-v3 spawning while
  the feature list and the managed-spawn section described v4.
- `pi-worktree`: the workspace-switching section named `/tree`; the registered
  command is `/worktree`.
- `pi-workflows`: removed an orphaned sentence fragment left behind by an edit
  to the saved-workflow paragraph.
- `pi-plan-mode`, `pi-goal`, `pi-usage-extension`: the stated Pi floor
  (`0.80.6`, `0.42.4+`) contradicted the declared `^0.84.0` peer range, which
  resolves to `0.84.x`. `pi-usage-extension` also carried a "Last updated"
  stamp from a version that predates the workspace baseline.
- `pi-welcome`: the example card was a real session capture. It is now a
  generic sample, and Install moved above the configuration sections instead of
  sitting below them.

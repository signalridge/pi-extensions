---
"@signalridge/pi-analytics": patch
"@signalridge/pi-gpt-fast": patch
"@signalridge/pi-herdr-state": patch
"@signalridge/pi-statusline": patch
"@signalridge/pi-workflows": patch
"@signalridge/pi-worktree": patch
---

Remove references to the maintainer's personal dotfile setup from shipped docs
and source comments. Each constraint is restated as a property of the package
itself: which manager owns a settings file, whether a project permits git
worktrees, and installing a package from a single source. No runtime behavior
changes.

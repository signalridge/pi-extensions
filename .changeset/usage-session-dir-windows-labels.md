---
"@signalridge/pi-usage-extension": patch
---

Read usage from the session directory Pi actually uses. `/usage` previously always scanned `<agentDir>/sessions`, missing sessions stored through `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting; it now follows the active session's directory as Pi resolved it. Windows working directories (`C:\Users\name\...`, including other machines' homes) collapse to `~` project labels like POSIX homes, and other drive paths drop the drive letter. Adapted from tmustier/pi-extensions `cf65f962`, `e38e1cf3` and `91a28802`.

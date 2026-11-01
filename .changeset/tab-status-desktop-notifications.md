---
"@signalridge/pi-tab-status": minor
---

Add opt-in desktop notifications. With `PI_TAB_STATUS_NOTIFY=1`, an interactive session raises one notification when a run settles (aborted runs stay silent) and once each time the tab enters the stalled `blocked` state. The escape sequence is chosen per terminal (OSC 99 for kitty, OSC 9 for iTerm2, OSC 777 otherwise), can be forced with `osc777`, `osc9` or `osc99`, and is wrapped for tmux passthrough. Text is limited to the project label and a fixed outcome, with control characters, bidi overrides and `;` removed. Non-TUI sessions, including subagent children, never notify. Notifications are off by default.

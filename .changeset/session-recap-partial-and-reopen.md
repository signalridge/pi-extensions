---
"@signalridge/pi-session-recap": minor
---

Recap sessions reopened from the command line (`pi -c`, `pi -r`, `--session`), which Pi reports as `startup`, unless the reopening prompt already started work.

Render only a cleanly stopped recap response: a truncated or aborted response is dropped instead of showing its first words, and a stream failure is reported through a UI notification instead of the console, which wrote over the TUI frame. Assistant messages copied into the recap request no longer carry the session's token usage, which could clamp the recap to about one output token in a long session. Adapted from tmustier/pi-extensions `1fcf4144`, `0c9b1165`, `19ccef78` and `b937a470`.

---
"@signalridge/pi-code-actions": patch
---

Copy snippets through Pi's own `copyToClipboard` instead of spawning clipboard utilities. `/code copy` now works in remote sessions (OSC 52, including `PI_CLIPBOARD_OSC52=1`), Termux and WSL, keeps Linux clipboard ownership after the copy, and reports Pi's failure reason. A copy pending when the session changes is no longer awaited or reported.

---
"@signalridge/pi-btw": patch
---

Preserve the current main-editor text synchronously when a committed session transition closes the /btw fullscreen UI. Pi restores the outgoing editor snapshot inside the custom UI's close callback; this fix retains a destination draft written by an earlier extension's session handler without overwriting a later handler's draft or resurrecting text after a canceled transition.

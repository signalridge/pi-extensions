---
"@signalridge/pi-statusline": patch
"@signalridge/pi-files-widget": patch
---

`pi-statusline` now has a single `/statusline` registration path. `registerStatuslineCommand()` existed but had no production caller — the runtime registered the command inline with its own session guard — so the tests exercised a wrapper the product never ran, and the guard existed on only one of the two paths. The runtime now goes through `registerStatuslineCommand()`, which takes the session check as an `isCurrentSession` option, so the covered path and the shipped path are the same one.

`pi-files-widget`'s `DESIGN.md` now states up front that it is a design document rather than a description of the shipped surface: the extension registers one command, `/readfiles`, while the document's *Proposed* and *Phase 2/3* sections describe `/review`, `/diff`, and external `tuicr`/`critique` integrations that do not exist.

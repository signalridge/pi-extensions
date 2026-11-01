---
"@signalridge/pi-sessions": patch
---

Fix two regressions on newer Pi hosts. On Pi 1.3 and later each `/sessions` or `/handoff` dialog left an invisible overlay open, so Pi behaved as if a dialog were always open and fullscreen scrollbar clicks and drags stopped working until restart; the placeholder overlay is now removed by its own handle. On Pi 1.2 and later the review editor and the session-picker filter showed literal cursor markers around the cursor instead of a highlighted cell; the sanitizer now admits Pi's own cursor markers while still cleaning untrusted input.

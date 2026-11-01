---
"@signalridge/pi-input-prefix": patch
---

Keep the shell-mode prompt and slash-command highlighting correct on pi-tui 1.2 and later, which draw the software cursor between zero-width markers instead of inline reverse video. With the cursor on the leading `!`, the bang is detached into the prompt token again instead of being rendered twice, the prompt cell keeps the host's own cursor styling, and slash-token highlighting no longer counts the markers as visible characters.

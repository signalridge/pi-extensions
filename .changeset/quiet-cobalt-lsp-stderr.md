---
"@signalridge/pi-lsp": patch
---

Keep a bounded UTF-8-safe tail of language-server stderr in memory and error messages without copying the entire tail for every chunk. Ignore output and exit events from a superseded server when a client restarts, and clear its partial JSON-RPC frame and cached diagnostics before opening the replacement.

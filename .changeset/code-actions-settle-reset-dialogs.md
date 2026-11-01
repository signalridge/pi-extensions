---
"@signalridge/pi-code-actions": patch
---

Settle a code-actions dialog that the host disposes without closing it. Pi 1.4 resets extension UI on `/reload` by disposing open dialogs; the pending picker or run-output pane is now resolved as cancelled instead of leaving its owner, and session retirement, waiting forever. Host-driven disposal settles locally without splicing Pi's dialog stack during reset, so adjacent foreign dialogs are disposed too; explicit completion still closes synchronously to preserve draft/navigation ordering. Clipboard copying is TUI-only; RPC reports unavailable instead of claiming an OSC52 server-side write reached the client.

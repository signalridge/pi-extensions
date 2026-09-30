---
"@signalridge/pi-usage-extension": patch
---

Stop cancelled `/usage` scans from waiting on a busy cache lock or writing after cancellation. Skip partial cache warming after a cancelled scan, and clean up owned locks and temporary files when an ordinary cache save is aborted.

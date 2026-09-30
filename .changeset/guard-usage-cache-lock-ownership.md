---
"@signalridge/pi-usage-extension": patch
---

Stop treating old cache locks as abandoned: concurrent writers now wait or fail closed, and a previous owner avoids unlinking a replaced lock. Make cache reads abortable while saving, and skip partial cache writes after a cancelled scan so cancellation returns without reprocessing a large cache.

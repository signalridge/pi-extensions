---
"@signalridge/pi-workflows": patch
---

Restore workflow keyword and standing `/effort high|ultra` authorization on Pi 1.2 and later. Those hosts report the session as busy while its own run starts, so the hidden guidance that authorizes the `workflow` tool was silently dropped for every idle prompt. The idle check now applies only on hosts that do not identify the starting run, and runs started by a custom message never consume an armed prompt.

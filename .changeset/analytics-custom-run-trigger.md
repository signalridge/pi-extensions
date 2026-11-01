---
"@signalridge/pi-analytics": patch
---

Record runs started by an idle custom message (for example a subagent completion notice) as extension-triggered again. Pi 1.2 and later announce those runs through `before_agent_start`, which labelled them `unknown` and could consume a pending user trigger.

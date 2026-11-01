---
"@signalridge/pi-goal": patch
---

Do not count runs started by an idle custom message, such as a subagent completion notice, as manual goal runs. Pi 1.2 and later announce those runs through `before_agent_start`; goal input accounting now treats only user prompts as prompt boundaries, as on earlier hosts.

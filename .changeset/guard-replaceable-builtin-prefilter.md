---
"@signalridge/pi-subagents": patch
---

Preselect child extensions through Pi's public package resolver before loading restrictive include/exclude policies on hosts with replaceable built-ins. An excluded discovered extension can no longer register `/mcp` first and displace a selected built-in; explicit extension paths retain priority, host-disabled built-ins remain disabled, and missing sources or changed settings fail clearly instead of silently dropping selected capabilities.

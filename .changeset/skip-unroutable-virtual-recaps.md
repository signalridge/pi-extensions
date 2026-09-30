---
"@signalridge/pi-session-recap": patch
---

Skip recaps for Pi virtual model selections unless a physical `--recap-model` override is configured. Tell manual `/recap` callers how to configure one, while keeping automatic skips quiet and preserving reasoning-off behavior.

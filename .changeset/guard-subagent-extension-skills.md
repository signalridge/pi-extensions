---
"@signalridge/pi-subagents": patch
---

Keep `skills: false` and named-skill subagents from inheriting skills added by loaded extensions via `resources_discover`. Apply the child skill policy after every Pi resource update, while leaving `skills: true` discovery unchanged.

---
"@signalridge/pi-subagents": patch
---

Restore the deprecated optional `model` and `thinking` fields on the exported `NewAgentInput` type so existing deep-import consumers continue to compile. Each present retired key, including inherited keys, now warns by name to use `tier`, without reading or logging its value. Manual agent files still serialize only `tier` for routing; legacy inputs are ignored, never translated into routing policy or written as ineffective frontmatter.

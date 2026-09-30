---
"@signalridge/pi-subagents": minor
---

Fail closed when raw `inherit_context: true` would copy pre-hook parent history into a child request: top-level, nested, and managed spawns now require an explicitly sanitized task summary instead, and child sessions persisted with inherited-history prompts cannot resume. Preserve the parent's configured providers and virtual model routes through a checked runtime bridge; refuse child creation on capable Pi hosts when that bridge is missing or incompatible rather than silently starting with a fresh model runtime. Older supported hosts retain their legacy model-registry option.

---
"@signalridge/pi-subagents": minor
---

Refuse automatic `inherit_context: true` before child creation on current Pi hosts: the parent projection precedes request-local redaction hooks and child provider routing cannot be pinned to the parent's physical endpoint. Supply a deliberately sanitized summary in the Agent task instead; previously persisted children containing inherited parent history must start a new session rather than resume. Carry the parent's checked ModelRuntime into child and mention sessions, failing before provider dispatch on hosts where an unavailable or incompatible runtime would otherwise silently lose custom providers and virtual routes.

---
"@signalridge/pi-session-recap": minor
---

Disable independent, history-bearing recap requests by default. Require both `--recap-allow-raw-history` and a concrete physical `--recap-model "provider/model-id"` destination; parent `context`-hook redactions do not apply to recap history. Also refuse auth-resolved endpoint overrides that differ from the selected model's registered base URL, rather than sending raw history to an unapproved physical destination. Manual `/recap` explains missing consent or an endpoint mismatch, while automatic triggers stay quiet.

---
"@signalridge/pi-rules": minor
---

Initial experimental release: project and user rule files (`.pi/rules`, `.agents/rules`, Cursor `.cursor/rules/*.mdc`, `<agent dir>/rules`) delivered as an always-on prompt section, an on-demand index with a `read_rule` tool, path-glob offers, and `edit`/`write`/`bash` rules that remind or block at `tool_call`, with branch-persisted repeat policy. Project rules load only in trusted projects. Adapted from oh-my-pi's rule system without its mid-stream interruption.

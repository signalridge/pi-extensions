# Changelog

## 1.2.0

- Initial experimental release: project and user rule files (`.pi/rules`, `.agents/rules`, `.cursor/rules/*.mdc`, `<agent dir>/rules`) delivered as one cache-stable system-prompt section, an on-demand index with a `read_rule` tool, glob-triggered rule offers, and regex rules enforced on `edit`/`write`/`bash`/`powershell` calls that either block the call or steer a hidden reminder. Repeat state (`once` per branch or `after-gap`) is recomputed from the session branch, so it survives `/reload` and re-arms after `/tree` navigation. Project rules load only in trusted projects. `/rules` lists rules, matches and rule-file errors.

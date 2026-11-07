# Retired packages

Retired packages receive no further releases here. Their published versions remain installable and are deprecated with migration guidance.

| Package | Last version | Replacement | Migration |
| --- | --- | --- | --- |
| `@signalridge/pi-herdr-state` | 1.3.3 | herdr's bundled Pi integration | Remove the package, then run `herdr integration install pi`. Load only one `herdr:pi` reporter. |
| `@signalridge/pi-approvals` | 1.3.0 | A permission extension such as `@gotgenes/pi-permission-system`, or a command blocker such as `cc-safety-net` | Remove the package. Background and Subagents no longer depend on its cooperation service. |
| `@signalridge/pi-approval-core` | 1.3.0 | None; internal library of `pi-approvals` | No remaining package depends on it. |

Retirement does not delete user sessions, permissions or configuration. Remove retired package declarations explicitly; do not run duplicate integrations during migration.

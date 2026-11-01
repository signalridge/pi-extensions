---
"@signalridge/pi-tab-status": patch
---

Show a run you abort as cancelled rather than finished. The tab returns to its bare project title instead of `review`/🚧 (or `blocked` when the abort surfaced as an error), and no desktop notification is raised. The host's `aborted` flag on `agent_settled` (Pi 1.1+) decides; older hosts fall back to the run's last stop reason.

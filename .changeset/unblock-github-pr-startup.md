---
"@signalridge/pi-github-pr": patch
---

Run the initial GitHub pull request refresh in the background so slow CLI calls do not block session startup. Keep startup discovery and refresh owned by the session so turn cancellation cannot disarm branch watching or periodic updates, while stale work is cancelled on session and branch changes.

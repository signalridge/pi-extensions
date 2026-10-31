---
"@signalridge/pi-goal": minor
---

Add `experimental.notices`, a setting beside `experimental.goals` that silences the session-start notice announcing the experimental ordered-goal queue. It defaults to `true`, so existing sessions report exactly as before, and it suppresses only that announcement: validation failures, settings-load warnings, and recovery notices still report because they describe a problem rather than restate a choice the user already made. The queue, its subcommands, and `queue off` freezing are unaffected, and the Settings menu exposes the new control directly under **Ordered goal queue**.

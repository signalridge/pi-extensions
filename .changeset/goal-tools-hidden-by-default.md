---
"@signalridge/pi-goal": minor
---

New `goal_wait` tool: a goal that depends on something outside the session — CI finishing, a review landing, a reply arriving — can now say so. Without it the model either burns continuation turns re-checking or reports a blocker that is not one; `goal_wait` records *why* it is waiting, pauses the goal, and either waits for the next real message or wakes itself on a deadline.

It reuses the existing `paused` state rather than adding a fourth one, so every resume path, restore path, and status surface already handles it, and the deadline resumes through the same code as `/goal resume` (tool-policy preparation, recovery clearing, prompt delivery) rather than a second, lesser resume. Requests below 10s are clamped rather than refused — the model's intent ("wait, then check") is right even when its number makes a polling loop — and the reply says when a number was raised. The wake-up re-checks at fire time that the goal is still the paused, active one, and a generation counter keeps an already-in-flight callback from waking a goal that was cleared microseconds earlier.

`toolVisibility` now defaults to `"after-first-goal"` instead of `"always"`.

`goal_complete` and `goal_blocked` are meaningless without an active goal, so in a session that never runs `/goal` — the overwhelming majority — their definitions and prompt guidelines were pure context cost paid on every request. They are now withheld until the first accepted `/goal` activation, and a session that restores an unfinished goal reveals them at startup as before.

Nothing else changes: the `"after-first-goal"` machinery is unchanged, missing and invalid settings both land on the new default (an unreadable settings file must not be a way to get the always-on behaviour), and `"always"` remains available for anyone who wants a tool schema that is identical from session startup.

Reload Pi after changing the setting, as before.

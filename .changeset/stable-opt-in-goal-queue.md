---
"@signalridge/pi-goal": minor
---

Promote the ordered goal queue's existing command and persisted-state compatibility contract to stable, with documented readiness evidence and consistent opt-in settings labels and announcements. Queue execution remains off by default. The fully supported `experimental.goals` and `experimental.notices` keys, command aliases, saved-state readers, freeze/re-enable behavior, settled activation, and ownership/accounting boundaries are unchanged. The once-per-session queue announcement is informational and still respects `notices: false`; validation and recovery warnings remain visible.

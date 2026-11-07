---
"@signalridge/pi-subagents": minor
---

Route eligible background subagent clarification to the existing main session instead of showing human dialogs, and remove the Agent tool's `supervisor_questions` parameter. Other child runs report blockers in their results; unanswered questions never fall back to a human popup. The main session resolves internal issues first and presents only genuine user decisions in the user's language, with a recommendation, brief background and consequences. Keep remembered-child reopening and foreground continuation usable without blocking on a question, and leave configuration and permission/approval confirmations unchanged.

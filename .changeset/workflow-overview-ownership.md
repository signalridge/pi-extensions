---
"@signalridge/pi-workflows": minor
"@signalridge/pi-subagents": minor
---

Give Workflows one rich below-editor overview and keep Subagents Fleet limited to independent agents. Preserve workflow navigation, completed-call token semantics, periodic projection/footer updates, and exact retained-child access through the owner navigator and explicit `/agents` retained-child paths, including when Fleet is disabled. No execution/model policy or managed/UI protocol changes.

Update both packages together for the new layout: older Subagents can still duplicate the new overview; newer Subagents paired with older Workflows leaves the older upper progress panel. Existing running sessions do not acquire these UI changes until a later normal activation.

# Dynamic registry ownership

Model routes and agent types are dynamic references. Their shape and owner are documented, but available names depend on active user/project configuration and are intentionally absent from static skill files.

## Model routes

The `pi-subagents` workflow-tier settings own route names. Standard routes are `small`, `medium`, and `large`; use another route only when its name and purpose are supplied in context. A route is selected with `tier`. An exact user-requested model is selected with `model` and is resolved/scope-checked by pi-subagents.

## Agent types

The agent registry owns agent-type names and their bound instructions, tools, model, and isolation policy. Use `agentType` only when context supplies both its name and purpose. Do not infer an agent type from a role-like label.

## Priority

Routing priority is explicit `model` > named `tier` > phase/run model > pi-subagents agent configuration > parent session. Higher priority means selection, not "try this then fall back to the next selector." Avoid specifying competing selectors unless deliberately overriding a lower-priority default.

Unavailability is fail-closed for explicit `model` and named tiers: pi-subagents reports the selector and does not silently run a different model. An omitted selector may inherit the parent session according to the companion's current settings.

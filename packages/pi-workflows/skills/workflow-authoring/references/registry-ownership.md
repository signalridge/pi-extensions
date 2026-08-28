# Dynamic registry ownership

Model routes and agent types are dynamic references. Their shape and owner are documented, but available names depend on active user/project configuration and are intentionally absent from static skill files.

## Model routes

The `pi-subagents` workflow-tier settings own route names. Standard routes are `small`, `medium`, and `large`; use another route only when its name and purpose are supplied in context. A route is selected with `tier`. An exact user-requested model is selected with `model` and is resolved/scope-checked by pi-subagents.

## Agent types

The agent registry owns agent-type names and their bound instructions, tools, model, and isolation policy. Use `agentType` only when context supplies both its name and purpose. Do not infer an agent type from a role-like label.

## Priority

An explicit per-call `model` wins. A named `agentType` model overrides a tier; an explicit `tier` suppresses the phase/run model so pi-subagents can apply the agent definition and then the selected workflow tier. Without a per-call model or tier, the phase/run model is used when present, followed by pi-subagents defaults and the parent session. Model and thinking fields are resolved independently. Avoid specifying competing selectors unless the override is deliberate.

Unavailability is fail-closed for explicit `model` and named tiers: pi-subagents reports the selector and does not silently run a different model. An omitted selector may inherit the parent session according to the companion's current settings.

# Dynamic registry ownership

Model routes and agent types are dynamic references. Their shape and owner are documented, but available names depend on active user/project configuration and are intentionally absent from static skill files.

## Model routes

pi-subagents owns the agent-tier catalogue; a workflow names a key from it and nothing else. Available tier names depend on active configuration and are intentionally absent from static skill files — read them from the destination context.

A name a script writes is not a claim that the name exists. Scripts that ship with this package name `low`/`medium`/`high` — the profiles a fresh install receives — and a host that does not define one of those drops it in favour of that host's default, with a log line. A script you write is held to the stricter rule: an undefined tier is a typo in a catalogue you own, so it is rejected before dispatch rather than rerouted. Write the tier you mean for the host you are targeting; do not copy `low`/`medium`/`high` in on the assumption that every machine has them.

## Agent types

The agent registry owns agent-type names and their bound instructions, tools, Agent-tier defaults, and isolation policy. Use `agentType` only when context supplies both its name and purpose. Do not infer an agent type from a role-like label.

## Priority

A call's `tier` takes precedence over an agent type's own tier default, which takes precedence over `agentTiers.defaultTier`. `resolveAgentTier()` in pi-subagents then resolves model, thinking, clamping, availability, and the immutable snapshot as one decision. Neither a call, nor workflow meta, nor a phase may carry model or thinking fields.

Unavailability is fail-closed: pi-subagents names the tier and does not silently run a different model. A managed call with no tier and no applicable default is rejected rather than inheriting the parent session.

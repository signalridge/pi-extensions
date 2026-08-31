# Dynamic registry ownership

Model routes and agent types are dynamic references. Their shape and owner are documented, but available names depend on active user/project configuration and are intentionally absent from static skill files.

## Model routes

pi-subagents owns the agent-tier catalogue. A workflow never names a key from it: a script names a *strength* (`low`/`medium`/`high`), and the user's `strengths` table is the only thing that binds one to a tier. Tier names depend on active configuration and are intentionally absent from static skill files; you do not need them, because you never write one.

A strength is a statement about the work, not a claim about the host. Every script — shipped or yours — names the same three, and there is no shipped/user distinction, because a strength can never reach the catalogue by itself: the binding is always an entry in a `strengths` table. A host that configured none uses the shipped default table, which is identity wherever the host defines a tier of the same name, so a stock machine honours your `low`/`medium` distinctions without configuration and a host with differently-named tiers leaves every strength unmapped. A user table replaces that default outright, and a strength it omits is unmapped even where a same-named tier exists — which is what lets workflow work be re-priced without touching the tier every ordinary spawn also names.

## Agent types

The agent registry owns agent-type names and their bound instructions, tools, Agent-tier defaults, and isolation policy. Use `agentType` only when context supplies both its name and purpose. Do not infer an agent type from a role-like label.

## Priority

A call's strength resolves through the user's `strengths` table into at most one tier key. That key, when there is one, takes precedence over an agent type's own tier default, which takes precedence over `agentTiers.defaultTier`. A call that names no strength, or one whose strength the table does not define, sends no key and leaves that precedence to the host — which is why there is no default strength: one would overrule every agent type's own tier on calls the script never meant to route. `resolveAgentTier()` in pi-subagents then resolves model, thinking, clamping, availability, and the immutable snapshot as one decision. Neither a call, nor workflow meta, nor a phase may carry model, thinking, or tier fields.

Unavailability is fail-closed: pi-subagents names the tier and does not silently run a different model. A managed call with no tier and no applicable default is rejected rather than inheriting the parent session — which an unmapped strength can reach on a host whose default has been cleared.

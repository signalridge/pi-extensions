---
"@signalridge/pi-subagents": minor
---

Add a settings interface for the subagent default model and tier. Both were
previously reachable only by hand-editing `subagents.json`.

`/agents → Settings` gains two rows. **Default model** writes a new
`defaultModel` key: the model a subagent runs when no tier picked one, slotting
in ahead of the parent session at the end of resolution, so a workspace can say
"subagents run on the cheap model" without first defining a tier catalogue. It
decides only the model — thinking still comes from the parent, since a level
nobody chose for a specific model is what a tier exists to express — and any
tier that applies overrides it. **Default tier** selects `agentTiers.defaultTier`
from the defined tier keys.

`/agents → Model tiers` is a new menu for the catalogue itself: create a tier,
change its model, thinking or description, or delete it. The model picker
enumerates pi's own registry (narrowed to your scope when Scope models is on)
plus `inherit` and a typed escape hatch for a provider this machine has not
authed. The thinking picker offers only the levels the chosen model reports as
supported, rather than a fixed list whose extra entries `clampThinkingLevel`
would silently lower at spawn. A tier dropped as malformed stays listed as
`blocked` so redefining it retires the tombstone in one step, and deleting the
tier that `defaultTier` names clears the default in the same write rather than
leaving every untiered spawn to fail.

Unlike a tier, an unresolvable `defaultModel` falls back to the parent model
instead of failing the spawn — a tier is refused because someone named that
policy at the call site, while `defaultModel` is the value nobody named, so one
unauthed provider must not take every spawn on the machine down with it. The
Settings row flags it as `(unavailable, fallback: inherit)`. `defaultModel`
accepts the literal `"inherit"`, which is how a project cancels a global default;
omitting the key still inherits whatever the global file set.

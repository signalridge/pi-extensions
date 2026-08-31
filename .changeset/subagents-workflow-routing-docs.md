---
"@signalridge/pi-subagents": patch
---

Document how a workflow now reaches this catalogue.

The "One catalogue, including for workflows" section said a workflow script names
a key from `agentTiers` directly, with "no second workflow-tier vocabulary and no
mapping layer" and `agent({ tier: "low" })` examples. pi-workflows scripts now
name a *strength* and a table on that side chooses the tier, so every claim in
that section was inverted and its example is rejected before dispatch.

The claim it was protecting is still true and is now stated where it belongs:
there is no second tier catalogue and no second resolver, a `strengths` value is
a key in this catalogue and never carries its own `model`/`thinking`, and a
request arriving here is indistinguishable from a spawn that named the key
itself. Also notes that the shipped `low`/`medium`/`high` profiles are what
pi-workflows' default table maps onto, so renaming them leaves workflows on the
ordinary untiered path rather than breaking them.

Drops a stale pointer to `workflow.tiers`, a settings key this package no longer
reads.

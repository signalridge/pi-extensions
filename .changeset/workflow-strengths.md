---
"@signalridge/pi-workflows": minor
---

A workflow now speaks one routing word of its own: **strength**.

`agent({ tier })` is gone. A script names `strength: "low" | "medium" | "high"` —
this package's own word for how much effort a step deserves — and the new
`strengths` setting is the only thing that binds one to an Agent tier. A strength
no table defines dispatches with **no tier at all** and takes the agent's ordinary
default, so nothing is inferred from spelling at dispatch: the binding is always a
table entry.

That inference was the bug. The built-ins ask for `low`, and so does the `Explore`
agent and everything that names no tier of its own, so pointing `low` at a cheaper
model to make a 26-agent fan-out affordable dragged every ordinary search spawn
with it. Pointing a *strength* elsewhere does not.

A host that has configured nothing gets a shipped default table rather than no
mappings: each strength on the catalogue tier of the same name, wherever the host
defines one — identity on a stock install, empty on a host whose tiers are called
`cheap`/`deep`. It is computed against the live catalogue, so it is never an
assertion about someone else's tier names and never complains at run start about
configuration nobody wrote. Without it every shipped script's `low`/`medium`
distinction would collapse onto pi-subagents' managed `medium` fallback — the
*more* expensive rung — and an unconfigured machine would run its fan-outs dearer
than before this change.

The distinction that makes that safe is that it is a **table, not a fallback
rule**. A rule would be unremovable, and re-pricing a fan-out would again mean
editing the shared tier. A table is replaced by writing one, a written table that
omits `low` leaves it unmapped even where a tier called `low` exists, and `{}` is
a real table meaning "map nothing".

This is not the retired `workflow.tiers` key. That one carried its own `model` and
`thinking`, making it a second model policy behind a second resolver. A value here
is a key in the host's one catalogue: pi-subagents still owns every model, every
thinking level, and the only `resolveAgentTier()`, and cannot tell a mapped call
apart from a spawn that named the key itself. No protocol change.

The vocabulary is closed, which buys back what the passthrough used to provide.
A word outside the three is a typo, not a strength nobody configured, so it fails
before dispatch. With no way for a script name to reach the catalogue, the
shipped-vs-user tier rule (`shippedScript`) had nothing left to decide and is
removed, along with its `run_created` journal field.

The same argument applies one level up, so `agent()` and `checkpoint()` now
reject any option name they do not read instead of ignoring it. `tier`, `model`,
and `thinking` answer by naming their replacement; anything else lists the legal
keys, and a non-object options value is refused rather than reaching a bare
`TypeError`. An unknown key is dropped before the call hash is built, so it moves
neither the dispatch nor the resume identity: `agent({ strenght: "low" })` would
have run every step untiered and replayed that way, and
`checkpoint({ headles: "abort" })` would have auto-approved in headless mode
instead of aborting. Neither leaves a log line. A script is plain JavaScript
authored against this contract, so nothing else was going to catch it. Both key
lists are pinned to their interfaces by a `satisfies Record<keyof …>` clause, in
both directions.

There is deliberately no default strength: a call that names none dispatches with
no tier, exactly as an unmapped one does, and the host resolves it the way it
resolves every other spawn. A default was tried and is wrong — a tier a call
requests outranks the agent type's own, so on a stock install (`medium → medium`)
every unlabelled dispatch would have pinned `medium` over whatever the agent
declared, overruling `Explore`'s shipped `tier: low` and re-pricing in the wrong
direction the one agent this indirection exists to leave alone. Nothing is lost:
a script that named no strength stated no opinion, and pi-subagents' ordinary
precedence is still user-owned policy.

What the table must reach is every call a script did label, and the shipped
scripts label all of theirs. The three helpers that dispatch on the script's
behalf — `verify`, `judgePanel`, `completenessCheck` — took no strength at all
and so could never be re-routed; they now accept one, defaulting to `low`, `low`,
and `medium`.

Those defaults are an opinion where there was none, and an opinion outranks the
host's: a tier a call requests beats `agentTiers.defaultTier`, so on a machine
whose default is `high` a `completenessCheck` now runs at whatever `medium` maps
to rather than at `high`. That is the price of making the helpers steerable at
all — a helper that names no tier can never be pointed anywhere — and the new
option is how a script takes it back.

Fixes a re-spend bug: `strengths` is deliberately never frozen onto a run, but the
resumes the engine starts itself (`/workflows resume`, the provider-limit retry)
passed no table, and since a call's identity keys on the tier it requested, every
finished call missed its journal entry and re-ran untabled. The engine now reads
the current table for those.

`/workflows-models` is gone; the table is edited with `/workflows strength`
(`[<low|medium|high> <tier>|off]`), which also prints the effective table and the
tiers this host defines — the one place both halves are visible. It validates the
strength and the target before writing and reports the resolved result rather than
echoing the write, so it can no longer claim a change the settings layer dropped.
`off` yields to a real host tier of that name, and says so when it does, since a
user who typed the documented keyword and got a mapping has to be told which
reading won. The view also names where a machine-wide table lives, and — while
the shipped default is in force — that the default is identity, so workflow work
is still sharing the tiers ordinary spawns use until a tier is defined for it.

Settings commands now write project scope instead of the merged view. Previously
the first `/effort` or `/workflows-progress` in a project copied every global value
and default into the project file, after which that project stopped tracking the
global one.

`strengths` needs the opposite treatment, because it replaces rather than merges at
each level, so `/workflows strength` seeds its write from the table a run would
actually use — project, else global, else the shipped default. Built on project
scope alone, setting one entry would have discarded an inherited global table, and
`off` against an entry the project never wrote would have written nothing and left
the mapping standing.

One caution the docs now carry: the provider-limit retry resumes on a timer with
nobody watching, so a table edited while a run is rate-limit-paused is charged the
re-spend above without being asked. Stop the run first if that is not worth it.

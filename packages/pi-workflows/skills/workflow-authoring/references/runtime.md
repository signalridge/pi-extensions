# Runtime authoring

Use this page for routine scripts. Open the generated capability index only when a signature, default, support boundary, or installed-version fact is missing here.

## Script envelope

Start with the only legal export: `export const meta = { name, description, phases?: [{ title, detail? }] }`. Values are nonblank literals; declare only used phases and call `phase()` before each phase's work. Workflow meta and phase objects must not contain `model` or `thinking`; those retired fields are rejected. The remaining body already runs inside an async function: write helpers as ordinary declarations; `export default` and other exports are invalid. Return the result explicitly.

The runtime supplies `agent`, `parallel`, `pipeline`, `orchestrate`, `workflow`, quality/control helpers, `phase`, `log`, `args`, `cwd`, restricted `process.cwd()`, and `budget`. Imports, `require()`, filesystem modules, `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable. The Node VM realm is implementation substrate, not a security boundary or public API.

## Topology

- `parallel()` takes thunks, runs independent work, and preserves input order. Await the whole array before whole-set synthesis.
- `pipeline()` runs stages sequentially per item while items proceed concurrently. Each stage receives `(previousValue, originalItem, index)` and forwards `null` to the next stage, so guard missing coverage first.
- `orchestrate()` is the preferred topology for named dependencies. Give each task a unique `id`, optional `dependsOn`, and a `run({ id, attempt, results, statuses })` callback. The runtime validates the graph, executes declaration-order ready layers behind barriers, and returns `{ results, tasks }`; use `onError: "continue"` only when a downstream task can handle failed dependencies.
- `workflow(name, childArgs?)` runs a context-supplied saved workflow. Nesting is one level, shares limits/counters/tokens/store, and journals the complete child result as one parent replay boundary.

## Data and failure

Call `agent(prompt, { label, schema?, strength? })`; it returns text, a schema-validated value, or recoverable `null`. `strength` is `low`/`medium`/`high` and has no default — omitting it sends no tier. Nonrecoverable limit, validation, budget, unknown-strength, and unavailable-tier failures throw. Record each intended work ID before filtering. A `null` means missing coverage, never a negative finding.

Use `agent(prompt, { thread: "implementer" })` when the same managed subagent must receive a later follow-up with its complete conversation intact. Reuse a thread name sequentially; never put same-thread calls in one `parallel()` batch. Threads are scoped to one workflow run/session and cannot use worktree isolation. A pause or process restart may require a fresh thread session.

When JavaScript reads fields, pass a small plain JSON Schema. Schema noncompliance after repair throws and bypasses agent retries. Catch it only to return an explicit incomplete outcome without reading missing fields. Return objects, arrays, strings, numbers, booleans, and `null`—not functions, promises, cycles, `BigInt`, or runtime handles.

## Routing and support

`strength` is this package's own vocabulary — `low`, `medium`, `high` — not a model ID and not an agent-tier key. A `strengths` table is the only thing that binds a strength to a tier: the user's, or a shipped default (identity, wherever the host defines a tier of the same name) on a host that configured none. A strength no table defines dispatches with no tier and takes the agent's own default, then `agentTiers.defaultTier`; a call that names no strength takes that same untiered path, because a default strength would have outranked the agent type's own tier on every unlabelled call. A word outside the three is rejected before dispatch, and so is any option name `agent()` does not read — `tier`, `model`, and `thinking` answer by naming their replacement, anything else lists the legal keys. `checkpoint()` gates its own options the same way. pi-subagents' `resolveAgentTier()` alone resolves the final model, thinking, clamping, availability, and snapshot. A host whose default has been cleared rejects an untiered call instead of inheriting the parent model. There is no per-call model, thinking, or tier, and workflow meta and phases may not carry them either. Worktree isolation remains owned by pi-subagents. See [registry ownership](registry-ownership.md).

Generated entries marked `supported` are authoring API. `console` and whole-script Markdown fences are compatibility-only. VM realm facilities are internal. Active model routes and agent types are dynamic. Use `log()` in new scripts.

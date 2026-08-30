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

Call `agent(prompt, { label, schema?, tier? })`; it returns text, a schema-validated value, or recoverable `null`. `tier` names a key in the host's agent-tier catalogue. Nonrecoverable limit, validation, budget, unknown-tier, and unavailable-tier failures throw. Record each intended work ID before filtering. A `null` means missing coverage, never a negative finding.

Use `agent(prompt, { thread: "implementer" })` when the same managed subagent must receive a later follow-up with its complete conversation intact. Reuse a thread name sequentially; never put same-thread calls in one `parallel()` batch. Threads are scoped to one workflow run/session and cannot use worktree isolation. A pause or process restart may require a fresh thread session.

When JavaScript reads fields, pass a small plain JSON Schema. Schema noncompliance after repair throws and bypasses agent retries. Catch it only to return an explicit incomplete outcome without reading missing fields. Return objects, arrays, strings, numbers, booleans, and `null`—not functions, promises, cycles, `BigInt`, or runtime handles.

## Routing and support

`tier` is a key in the host's agent-tier catalogue, not a model ID. The catalogue and its names belong to the user running the workflow; read the available keys from the destination context rather than assuming any particular name exists. A tier this host does not define is rejected before dispatch — only the scripts shipped with this package reroute to the host default instead, because they cannot know the catalogue they will land in. pi-subagents' `resolveAgentTier()` alone resolves the final model, thinking, clamping, availability, and snapshot. A tier the host does not define is rejected before dispatch. Omitting `tier` uses the agent's own tier, then `agentTiers.defaultTier`; a host whose default has been cleared rejects the call instead of inheriting the parent model. There is no per-call model or thinking, and workflow meta and phases may not carry them either. Worktree isolation remains owned by pi-subagents. See [registry ownership](registry-ownership.md).

Generated entries marked `supported` are authoring API. `console` and whole-script Markdown fences are compatibility-only. VM realm facilities are internal. Active model routes and agent types are dynamic. Use `log()` in new scripts.

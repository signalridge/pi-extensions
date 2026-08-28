# Runtime authoring

Use this page for routine scripts. Open the generated capability index only when a signature, default, support boundary, or installed-version fact is missing here.

## Script envelope

Start with the only legal export: `export const meta = { name, description, phases?: [{ title, detail?, model? }] }`. Values are nonblank literals; declare only used phases and call `phase()` before each phase's work. The remaining body already runs inside an async function: write helpers as ordinary declarations; `export default` and other exports are invalid. Return the result explicitly.

The runtime supplies `agent`, `parallel`, `pipeline`, `orchestrate`, `workflow`, quality/control helpers, `phase`, `log`, `args`, `cwd`, restricted `process.cwd()`, and `budget`. Imports, `require()`, filesystem modules, `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable. The Node VM realm is implementation substrate, not a security boundary or public API.

## Topology

- `parallel()` takes thunks, runs independent work, and preserves input order. Await the whole array before whole-set synthesis.
- `pipeline()` runs stages sequentially per item while items proceed concurrently. Each stage receives `(previousValue, originalItem, index)` and forwards `null` to the next stage, so guard missing coverage first.
- `orchestrate()` is the preferred topology for named dependencies. Give each task a unique `id`, optional `dependsOn`, and a `run({ id, attempt, results, statuses })` callback. The runtime validates the graph, executes declaration-order ready layers behind barriers, and returns `{ results, tasks }`; use `onError: "continue"` only when a downstream task can handle failed dependencies.
- `workflow(name, childArgs?)` runs a context-supplied saved workflow. Nesting is one level, shares limits/counters/tokens/store, and journals the complete child result as one parent replay boundary.

## Data and failure

Call `agent(prompt, { label, schema? })`; it returns text, a schema-validated value, or recoverable `null`. Nonrecoverable limit, validation, and budget failures throw. Record each intended work ID before filtering. A `null` means missing coverage, never a negative finding.

Use `agent(prompt, { thread: "implementer" })` when the same managed subagent must receive a later follow-up with its complete conversation intact. Reuse a thread name sequentially; never put same-thread calls in one `parallel()` batch. Threads are scoped to one workflow run/session and cannot use worktree isolation. A pause or process restart may require a fresh thread session.

When JavaScript reads fields, pass a small plain JSON Schema. Schema noncompliance after repair throws and bypasses agent retries. Catch it only to return an explicit incomplete outcome without reading missing fields. Return objects, arrays, strings, numbers, booleans, and `null`—not functions, promises, cycles, `BigInt`, or runtime handles.

## Routing and support

An explicit per-call `model` wins. A named `agentType` model overrides `tier`; specifying `tier` suppresses the phase/run model and delegates model/thinking resolution to pi-subagents. Without a per-call selector, the phase/run model is used when present, followed by pi-subagents defaults and the parent session. Explicit unavailable models and tiers fail closed. Worktree isolation is also fail-closed and remains owned by pi-subagents. See [registry ownership](registry-ownership.md).

Generated entries marked `supported` are authoring API. `console` and whole-script Markdown fences are compatibility-only. VM realm facilities are internal. Active model routes and agent types are dynamic. Use `log()` in new scripts.

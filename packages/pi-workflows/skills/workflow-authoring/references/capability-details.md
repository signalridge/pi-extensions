<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->
# Exhaustive workflow capability facts

Contract format: `1.0.0`<br>
Contract content / skill / extension: `1.3.2`

Every exact fact below is projected from the installed extension's capability contract. Explanatory judgment belongs in the hand-written references next to this file.

<!-- BEGIN GENERATED WORKFLOW CAPABILITY FACTS -->
<a id="runtime-global-agent"></a>
## agent

- Classification: `runtime-global`
- Support: `supported`
- Signature: `agent(prompt, options?) => Promise<string \| structured value \| null>`
- `label`: string (optional); default: derived from phase and call count
- `phase`: string (optional); default: current phase
- `schema`: plain JSON Schema (optional)
- `model`: string (optional); default: pi-subagents model resolver
- `tier`: small\|medium\|large (optional); default: pi-subagents workflow tier
- `isolation`: "worktree" (optional); default: pi-subagents worktree policy
- `thread`: string (optional); default: fresh session per call
- `toolset`: string (optional); default: configured host/agent toolset hint
- `excludeTools`: string[] (optional)
- `agentType`: string (optional); default: general-purpose
- `timeoutMs`: number \| null (optional); default: 300000 (5min); null disables
- `retries`: number (optional); default: run retry count
- Constraint: recoverable failures return null after retries; nonrecoverable failures throw
- Constraint: schema noncompliance after bounded repair attempts is nonrecoverable
- Constraint: resume replays only the longest unchanged prefix; the first miss and every later call execute live
- Constraint: replayed calls do not consume the real-dispatch maxAgents or token/phase budgets
- Constraint: spawnKeys rotate by generation on resume so pi-subagents never raises a fingerprint conflict
- Constraint: explicit model is resolved and scope-checked by pi-subagents; unavailable selectors fail closed
- Constraint: same-thread calls must be sequential and preserve a stable workflow thread name
- Constraint: threads cannot be combined with worktree isolation

<a id="runtime-global-parallel"></a>
## parallel

- Classification: `runtime-global`
- Support: `supported`
- Signature: `parallel(thunks) => Promise<Array<unknown \| null>>`
- Constraint: requires functions rather than promises
- Constraint: result order matches input order
- Constraint: recoverable thunk failures become null; nonrecoverable failures throw after the batch barrier settles
- Constraint: a breached agent cap cancels only its own batch
- Constraint: accepts at most 4096 thunks per call

<a id="runtime-global-pipeline"></a>
## pipeline

- Classification: `runtime-global`
- Support: `supported`
- Signature: `pipeline(items, ...stages) => Promise<Array<unknown \| null>>`
- Constraint: items run concurrently while stages per item run sequentially
- Constraint: each stage receives previousValue, originalItem, and zero-based index
- Constraint: a null stage result is passed to the next stage
- Constraint: accepts at most 4096 items per call and awaits the whole batch before surfacing fatal errors

<a id="runtime-global-orchestrate"></a>
## orchestrate

- Classification: `runtime-global`
- Support: `supported`
- Signature: `orchestrate(tasks, options?) => Promise<{ results, tasks }>`
- `onError`: "skip-dependents"\|"continue"\|"fail-fast" (optional); default: "skip-dependents"
- Constraint: task ids and dependencies are validated before any callback runs
- Constraint: ready tasks run in declaration-order layers with a barrier between layers
- Constraint: task context carries detached named results and statuses
- Constraint: ordinary task failures can retry up to three times; fatal workflow errors propagate
- Constraint: failed or skipped dependencies skip descendants by default; continue runs them with null values
- Constraint: the graph accepts at most 128 tasks and emits task start/retry/end/skip runtime events

<a id="runtime-global-workflow"></a>
## workflow

- Classification: `runtime-global`
- Support: `supported`
- Signature: `workflow(savedName, childArgs?) => Promise<unknown>`
- Constraint: one nested level; concurrent sibling nested calls are allowed
- Constraint: shares limiter, counters, token accounting, and store
- Constraint: nested calls use call-index/generation namespaces and replay as one parent result

<a id="runtime-global-verify"></a>
## verify

- Classification: `runtime-global`
- Support: `supported`
- Signature: `verify(item, options?) => Promise<{ real, realCount, total, votes }>`
- `reviewers`: number (optional); default: 2
- `threshold`: number (optional); default: 0.5
- `lens`: string \| string[] (optional)
- Constraint: threshold comparison is inclusive; real is false when no reviewer succeeds

<a id="runtime-global-judgepanel"></a>
## judgePanel

- Classification: `runtime-global`
- Support: `supported`
- Signature: `judgePanel(attempts, options?) => Promise<{ index, attempt, score, judgments } \| undefined>`
- `judges`: number (optional); default: 3
- `rubric`: string (optional); default: overall quality and correctness
- Constraint: highest mean score wins with stable input index as the tie-break; empty input returns undefined

<a id="runtime-global-loopuntildry"></a>
## loopUntilDry

- Classification: `runtime-global`
- Support: `supported`
- Signature: `loopUntilDry({ round, key?, consecutiveEmpty?, maxRounds? }) => Promise<unknown[]>`
- `round`: (roundIndex) => unknown[]; default: required
- `key`: (item) => string (optional); default: JSON.stringify
- `consecutiveEmpty`: number (optional); default: 2
- `maxRounds`: number (optional); default: 50
- Constraint: budget/agent-limit exhaustion returns the partial array instead of throwing

<a id="runtime-global-completenesscheck"></a>
## completenessCheck

- Classification: `runtime-global`
- Support: `supported`
- Signature: `completenessCheck(taskArgs, results) => Promise<{ complete, missing? } \| null>`
- Constraint: only the first 4,000 characters of serialized result evidence are sent to the critic

<a id="runtime-global-retry"></a>
## retry

- Classification: `runtime-global`
- Support: `supported`
- Signature: `retry(thunk, options?) => Promise<unknown>`
- `attempts`: number (optional); default: 3
- `until`: (result) => boolean (optional); default: accept first result
- Constraint: until must be synchronous

<a id="runtime-global-gate"></a>
## gate

- Classification: `runtime-global`
- Support: `supported`
- Signature: `gate(thunk, validator, options?) => Promise<{ ok, value, attempts }>`
- `attempts`: number (optional); default: 3
- Constraint: a value is accepted only when the validator returns an object with a truthy ok

<a id="runtime-global-checkpoint"></a>
## checkpoint

- Classification: `runtime-global`
- Support: `supported`
- Signature: `checkpoint(prompt, options?) => Promise<unknown>`
- `default`: unknown (optional); default: true when no UI and omitted
- `headless`: "default" \| "abort" (optional); default: "default"
- `kind`: "confirm" \| "input" \| "select" (optional); default: "confirm"
- `choices`: string[] (optional)
- `timeoutMs`: number (optional)
- Constraint: consumes one agent slot and no tokens
- Constraint: journaled answers replay only within an unchanged resume prefix

<a id="runtime-global-log"></a>
## log

- Classification: `runtime-global`
- Support: `supported`
- Signature: `log(message) => void`

<a id="runtime-global-console"></a>
## console

- Classification: `runtime-global`
- Support: `supported`
- Signature: `console: { log, info, warn, error }`
- Constraint: compatibility only — new workflows should use log()

<a id="runtime-global-phase"></a>
## phase

- Classification: `runtime-global`
- Support: `supported`
- Signature: `phase(title, options?) => void`
- `budget`: number (optional); default: positive soft pre-call token gate
- Constraint: phase budgets are soft pre-call gates

<a id="runtime-global-args"></a>
## args

- Classification: `runtime-global`
- Support: `supported`
- Signature: `args: unknown`

<a id="runtime-global-cwd"></a>
## cwd

- Classification: `runtime-global`
- Support: `supported`
- Signature: `cwd: string`

<a id="runtime-global-process"></a>
## process

- Classification: `runtime-global`
- Support: `supported`
- Signature: `process: { cwd(): string }`
- Constraint: restricted: only cwd() is exposed

<a id="runtime-global-budget"></a>
## budget

- Classification: `runtime-global`
- Support: `supported`
- Signature: `budget: { total, spent(), remaining() }`
- Constraint: frozen view over shared soft token accounting; nested workflows share the same accounting

<a id="workflow-tool-input-script"></a>
## script

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `script?: string`
- Constraint: required raw JavaScript workflow source unless `name` is given

<a id="workflow-tool-input-name"></a>
## name

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `name?: string`
- Constraint: resolves a saved workflow first, then one of the 5 built-in patterns
- Constraint: mutually exclusive with script and resumeFromRunId

<a id="workflow-tool-input-args"></a>
## args

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `args?: unknown`

<a id="workflow-tool-input-background"></a>
## background

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `background?: boolean = true`
- Constraint: background workflows are headless; use background false when checkpoint must show foreground confirmation

<a id="workflow-tool-input-maxagents"></a>
## maxAgents

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `maxAgents?: number = 1000`

<a id="workflow-tool-input-concurrency"></a>
## concurrency

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `concurrency?: number`
- Constraint: runtime clamps to 1..16

<a id="workflow-tool-input-agentretries"></a>
## agentRetries

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `agentRetries?: number = 0`
- Constraint: floored and clamped to 0..3

<a id="workflow-tool-input-agenttimeoutms"></a>
## agentTimeoutMs

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `agentTimeoutMs?: number = 300000`
- Constraint: null disables the hard timeout; default 300000ms (5min)

<a id="workflow-tool-input-tokenbudget"></a>
## tokenBudget

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `tokenBudget?: number`
- Constraint: soft pre-call gate; in-flight work can overshoot

<a id="workflow-tool-input-resumefromrunid"></a>
## resumeFromRunId

- Classification: `workflow-tool-input`
- Support: `supported`
- Signature: `resumeFromRunId?: string`
- Constraint: resumes a prior incomplete run with an edited script
- Constraint: original args and execution limits are reused on resume
- Constraint: unchanged positional calls replay from cache until the first changed call
- Constraint: always runs in the background

<a id="script-contract-export-const-meta"></a>
## export const meta

- Classification: `script-contract`
- Support: `supported`
- Signature: `export const meta = { name, description, phases? }`
- Constraint: must be the first statement
- Constraint: name and description must be nonblank literals
- Constraint: spread, computed keys, methods, template interpolation, and __proto__/constructor/prototype are rejected

<a id="script-contract-determinism"></a>
## determinism

- Classification: `script-contract`
- Support: `supported`
- Signature: `Date.now(), Math.random(), no-argument new Date() unavailable`
- Constraint: pass timestamps and randomness through args

<!-- END GENERATED WORKFLOW CAPABILITY FACTS -->

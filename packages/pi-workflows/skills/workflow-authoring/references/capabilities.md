<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->
# Workflow capability index

Contract format: `2.0.0`<br>
Contract content / skill / extension: `1.5.0`

This compact generated index covers supported runtime globals and workflow-tool inputs. For constraints, compatibility behavior, internal boundaries, and dynamic-reference ownership, follow the [exhaustive generated facts](capability-details.md).

## Supported capability index

<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
| Name | Classification | Signature | Options and defaults |
| --- | --- | --- | --- |
| agent | runtime-global | `agent(prompt, options?) => Promise<string \| structured value \| null>` | `label`: string (optional); default: derived from phase and call count<br>`phase`: string (optional); default: current phase<br>`schema`: plain JSON Schema (optional)<br>`tier`: agent tier key (optional); default: the agent's own tier, else agentTiers.defaultTier<br>`isolation`: "worktree" (optional); default: pi-subagents worktree policy<br>`thread`: string (optional); default: fresh session per call<br>`toolset`: string (optional); default: configured host/agent toolset hint<br>`excludeTools`: string[] (optional)<br>`agentType`: string (optional); default: general-purpose<br>`timeoutMs`: number \| null (optional); default: 300000 (5min); null disables<br>`retries`: number (optional); default: run retry count |
| parallel | runtime-global | `parallel(thunks) => Promise<Array<unknown \| null>>` | — |
| pipeline | runtime-global | `pipeline(items, ...stages) => Promise<Array<unknown \| null>>` | — |
| orchestrate | runtime-global | `orchestrate(tasks, options?) => Promise<{ results, tasks }>` | `onError`: "skip-dependents"\|"continue"\|"fail-fast" (optional); default: "skip-dependents" |
| workflow | runtime-global | `workflow(savedName, childArgs?) => Promise<unknown>` | — |
| verify | runtime-global | `verify(item, options?) => Promise<{ real, realCount, total, votes }>` | `reviewers`: number (optional); default: 2<br>`threshold`: number (optional); default: 0.5<br>`lens`: string \| string[] (optional) |
| judgePanel | runtime-global | `judgePanel(attempts, options?) => Promise<{ index, attempt, score, judgments } \| undefined>` | `judges`: number (optional); default: 3<br>`rubric`: string (optional); default: overall quality and correctness |
| loopUntilDry | runtime-global | `loopUntilDry({ round, key?, consecutiveEmpty?, maxRounds? }) => Promise<unknown[]>` | `round`: (roundIndex) => unknown[]; default: required<br>`key`: (item) => string (optional); default: JSON.stringify<br>`consecutiveEmpty`: number (optional); default: 2<br>`maxRounds`: number (optional); default: 50 |
| completenessCheck | runtime-global | `completenessCheck(taskArgs, results) => Promise<{ complete, missing? } \| null>` | — |
| retry | runtime-global | `retry(thunk, options?) => Promise<unknown>` | `attempts`: number (optional); default: 3<br>`until`: (result) => boolean (optional); default: accept first result |
| gate | runtime-global | `gate(thunk, validator, options?) => Promise<{ ok, value, attempts }>` | `attempts`: number (optional); default: 3 |
| checkpoint | runtime-global | `checkpoint(prompt, options?) => Promise<unknown>` | `default`: unknown (optional); default: true when no UI and omitted<br>`headless`: "default" \| "abort" (optional); default: "default"<br>`kind`: "confirm" \| "input" \| "select" (optional); default: "confirm"<br>`choices`: string[] (optional)<br>`timeoutMs`: number (optional) |
| log | runtime-global | `log(message) => void` | — |
| console | runtime-global | `console: { log, info, warn, error }` | — |
| phase | runtime-global | `phase(title, options?) => void` | `budget`: number (optional); default: positive soft pre-call token gate |
| args | runtime-global | `args: unknown` | — |
| cwd | runtime-global | `cwd: string` | — |
| process | runtime-global | `process: { cwd(): string }` | — |
| budget | runtime-global | `budget: { total, spent(), remaining() }` | — |
| script | workflow-tool-input | `script?: string` | — |
| name | workflow-tool-input | `name?: string` | — |
| args | workflow-tool-input | `args?: unknown` | — |
| background | workflow-tool-input | `background?: boolean = true` | — |
| maxAgents | workflow-tool-input | `maxAgents?: number = 1000` | — |
| concurrency | workflow-tool-input | `concurrency?: number` | — |
| agentRetries | workflow-tool-input | `agentRetries?: number = 0` | — |
| agentTimeoutMs | workflow-tool-input | `agentTimeoutMs?: number = 300000` | — |
| tokenBudget | workflow-tool-input | `tokenBudget?: number` | — |
| resumeFromRunId | workflow-tool-input | `resumeFromRunId?: string` | — |
| export const meta | script-contract | `export const meta = { name, description, phases? }` | — |
| determinism | script-contract | `Date.now(), Math.random(), no-argument new Date() unavailable` | — |
<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->

/**
 * capabilities.ts — machine-readable workflow capability contract (A11).
 *
 * One authoritative declaration of the runtime surface: every global a script
 * may use, every option a helper accepts, and every workflow-tool input. The
 * runtime builds its bindings from this declaration, and `check:capabilities`
 * asserts that the shipped docs (README) stay aligned — the tool schema,
 * documentation, and the real runtime face cannot drift apart.
 */

import type { WorkflowRuntimeBindings } from "./runtime.js";

/** Classification of a capability entry. */
export type CapabilityClass = "runtime-global" | "workflow-tool-input" | "script-contract";

export interface CapabilityOption {
  name: string;
  kind: string;
  optional: boolean;
  default: string;
}

export interface CapabilityEntry {
  name: string;
  classification: CapabilityClass;
  signature: string;
  options: CapabilityOption[];
  constraints: string[];
}

/** The contract format version. Bump on any breaking surface change. */
export const WORKFLOW_CAPABILITY_CONTRACT_VERSION = "2.0.0";

/**
 * The runtime globals a script can rely on. `options` documents each helper's
 * accepted inputs with defaults; `constraints` states the behavioral contract.
 *
 * The strength option's type is spelled out on each of the four helpers that
 * take it, rather than derived from `WORKFLOW_STRENGTHS`, because this array
 * must stay literal-only: `check:capabilities` evaluates it in an empty VM
 * realm so the published contract can be read without executing this package.
 * `strengths.test.ts` pins the four copies against the vocabulary the runtime
 * enforces, which is the drift protection a shared constant would otherwise
 * have provided.
 */
export const WORKFLOW_CAPABILITIES: readonly CapabilityEntry[] = [
  {
    name: "agent",
    classification: "runtime-global",
    signature: "agent(prompt, options?) => Promise<string | structured value | null>",
    options: [
      { name: "label", kind: "string", optional: true, default: "derived from phase and call count" },
      { name: "phase", kind: "string", optional: true, default: "current phase" },
      { name: "schema", kind: "plain JSON Schema", optional: true, default: "none" },
      {
        name: "strength",
        kind: '"low" | "medium" | "high"',
        optional: true,
        default: "no tier is sent; the agent's own tier, else agentTiers.defaultTier",
      },
      { name: "isolation", kind: '"worktree"', optional: true, default: "pi-subagents worktree policy" },
      { name: "thread", kind: "string", optional: true, default: "fresh session per call" },
      { name: "toolset", kind: "string", optional: true, default: "configured host/agent toolset hint" },
      { name: "excludeTools", kind: "string[]", optional: true, default: "none" },
      { name: "agentType", kind: "string", optional: true, default: "general-purpose" },
      { name: "timeoutMs", kind: "number | null", optional: true, default: "300000 (5min); null disables" },
      { name: "retries", kind: "number", optional: true, default: "run retry count" },
    ],
    constraints: [
      "recoverable failures return null after retries; nonrecoverable failures throw",
      "schema noncompliance after bounded repair attempts is nonrecoverable",
      "resume replays only the longest unchanged prefix; the first miss and every later call execute live",
      "replayed calls do not consume the real-dispatch maxAgents or token/phase budgets",
      "spawnKeys rotate by generation on resume so pi-subagents never raises a fingerprint conflict",
      "strength is this package's own vocabulary, not an agentTiers key; a word outside low/medium/high is rejected before dispatch",
      "a strengths table alone binds a strength to an agent tier; an unmapped strength dispatches with no tier and takes the agent's own default",
      "a call that names no strength also dispatches with no tier; there is no default strength, so an unlabelled call never outranks the agent type's own tier",
      "an unconfigured host uses a shipped default table: each strength on the catalogue tier of the same name, where the host defines one",
      "resolveAgentTier in pi-subagents owns model, thinking, clamping, availability, and the resolution snapshot",
      "there is no per-call model, thinking, or tier: a strength is the only model policy a workflow can express",
      "same-thread calls must be sequential and preserve a stable workflow thread name",
      "threads cannot be combined with worktree isolation",
      "an option name outside this list is rejected before dispatch, not ignored; tier, model, and thinking name their replacement",
    ],
  },
  {
    name: "parallel",
    classification: "runtime-global",
    signature: "parallel(thunks) => Promise<Array<unknown | null>>",
    options: [],
    constraints: [
      "requires functions rather than promises",
      "result order matches input order",
      "recoverable thunk failures become null; nonrecoverable failures throw after the batch barrier settles",
      "a breached agent cap cancels only its own batch",
      "accepts at most 4096 thunks per call",
    ],
  },
  {
    name: "pipeline",
    classification: "runtime-global",
    signature: "pipeline(items, ...stages) => Promise<Array<unknown | null>>",
    options: [],
    constraints: [
      "items run concurrently while stages per item run sequentially",
      "each stage receives previousValue, originalItem, and zero-based index",
      "a null stage result is passed to the next stage",
      "accepts at most 4096 items per call and awaits the whole batch before surfacing fatal errors",
    ],
  },
  {
    name: "orchestrate",
    classification: "runtime-global",
    signature: "orchestrate(tasks, options?) => Promise<{ results, tasks }>",
    options: [
      {
        name: "onError",
        kind: '"skip-dependents"|"continue"|"fail-fast"',
        optional: true,
        default: '"skip-dependents"',
      },
    ],
    constraints: [
      "task ids and dependencies are validated before any callback runs",
      "ready tasks run in declaration-order layers with a barrier between layers",
      "task context carries detached named results and statuses",
      "ordinary task failures can retry up to three times; fatal workflow errors propagate",
      "failed or skipped dependencies skip descendants by default; continue runs them with null values",
      "the graph accepts at most 128 tasks and emits task start/retry/end/skip runtime events",
    ],
  },
  {
    name: "workflow",
    classification: "runtime-global",
    signature: "workflow(savedName, childArgs?) => Promise<unknown>",
    options: [],
    constraints: [
      "one nested level; concurrent sibling nested calls are allowed",
      "shares limiter, counters, token accounting, and store",
      "nested calls use call-index/generation namespaces and replay as one parent result",
    ],
  },
  {
    name: "verify",
    classification: "runtime-global",
    signature: "verify(item, options?) => Promise<{ real, realCount, total, votes }>",
    options: [
      { name: "reviewers", kind: "number", optional: true, default: "2" },
      { name: "threshold", kind: "number", optional: true, default: "0.5" },
      { name: "lens", kind: "string | string[]", optional: true, default: "none" },
      { name: "strength", kind: '"low" | "medium" | "high"', optional: true, default: '"low"' },
    ],
    constraints: ["threshold comparison is inclusive; real is false when no reviewer succeeds"],
  },
  {
    name: "judgePanel",
    classification: "runtime-global",
    signature: "judgePanel(attempts, options?) => Promise<{ index, attempt, score, judgments } | undefined>",
    options: [
      { name: "judges", kind: "number", optional: true, default: "3" },
      { name: "rubric", kind: "string", optional: true, default: "overall quality and correctness" },
      { name: "strength", kind: '"low" | "medium" | "high"', optional: true, default: '"low"' },
    ],
    constraints: ["highest mean score wins with stable input index as the tie-break; empty input returns undefined"],
  },
  {
    name: "loopUntilDry",
    classification: "runtime-global",
    signature: "loopUntilDry({ round, key?, consecutiveEmpty?, maxRounds? }) => Promise<unknown[]>",
    options: [
      { name: "round", kind: "(roundIndex) => unknown[]", optional: false, default: "required" },
      { name: "key", kind: "(item) => string", optional: true, default: "JSON.stringify" },
      { name: "consecutiveEmpty", kind: "number", optional: true, default: "2" },
      { name: "maxRounds", kind: "number", optional: true, default: "50" },
    ],
    constraints: ["budget/agent-limit exhaustion returns the partial array instead of throwing"],
  },
  {
    name: "completenessCheck",
    classification: "runtime-global",
    signature: "completenessCheck(taskArgs, results, options?) => Promise<{ complete, missing? } | null>",
    options: [{ name: "strength", kind: '"low" | "medium" | "high"', optional: true, default: '"medium"' }],
    constraints: ["only the first 4,000 characters of serialized result evidence are sent to the critic"],
  },
  {
    name: "retry",
    classification: "runtime-global",
    signature: "retry(thunk, options?) => Promise<unknown>",
    options: [
      { name: "attempts", kind: "number", optional: true, default: "3" },
      { name: "until", kind: "(result) => boolean", optional: true, default: "accept first result" },
    ],
    constraints: ["until must be synchronous"],
  },
  {
    name: "gate",
    classification: "runtime-global",
    signature: "gate(thunk, validator, options?) => Promise<{ ok, value, attempts }>",
    options: [{ name: "attempts", kind: "number", optional: true, default: "3" }],
    constraints: ["a value is accepted only when the validator returns an object with a truthy ok"],
  },
  {
    name: "checkpoint",
    classification: "runtime-global",
    signature: "checkpoint(prompt, options?) => Promise<unknown>",
    options: [
      { name: "default", kind: "unknown", optional: true, default: "true when no UI and omitted" },
      { name: "headless", kind: '"default" | "abort"', optional: true, default: '"default"' },
      { name: "kind", kind: '"confirm" | "input" | "select"', optional: true, default: '"confirm"' },
      { name: "choices", kind: "string[]", optional: true, default: "none" },
      { name: "timeoutMs", kind: "number", optional: true, default: "none" },
    ],
    constraints: [
      "consumes one agent slot and no tokens",
      "journaled answers replay only within an unchanged resume prefix",
      "an option name outside this list is rejected rather than ignored, since a dropped headless silently auto-approves",
    ],
  },
  { name: "log", classification: "runtime-global", signature: "log(message) => void", options: [], constraints: [] },
  {
    name: "console",
    classification: "runtime-global",
    signature: "console: { log, info, warn, error }",
    options: [],
    constraints: ["compatibility only — new workflows should use log()"],
  },
  {
    name: "phase",
    classification: "runtime-global",
    signature: "phase(title, options?) => void",
    options: [{ name: "budget", kind: "number", optional: true, default: "positive soft pre-call token gate" }],
    constraints: ["phase budgets are soft pre-call gates"],
  },
  { name: "args", classification: "runtime-global", signature: "args: unknown", options: [], constraints: [] },
  { name: "cwd", classification: "runtime-global", signature: "cwd: string", options: [], constraints: [] },
  {
    name: "process",
    classification: "runtime-global",
    signature: "process: { cwd(): string }",
    options: [],
    constraints: ["restricted: only cwd() is exposed"],
  },
  {
    name: "budget",
    classification: "runtime-global",
    signature: "budget: { total, spent(), remaining() }",
    options: [],
    constraints: ["frozen view over shared soft token accounting; nested workflows share the same accounting"],
  },
  {
    name: "script",
    classification: "workflow-tool-input",
    signature: "script?: string",
    options: [],
    constraints: ["required raw JavaScript workflow source unless `name` is given"],
  },
  {
    name: "name",
    classification: "workflow-tool-input",
    signature: "name?: string",
    options: [],
    constraints: [
      "resolves a saved workflow first, then one of the 5 built-in patterns",
      "mutually exclusive with script and resumeFromRunId",
    ],
  },
  { name: "args", classification: "workflow-tool-input", signature: "args?: unknown", options: [], constraints: [] },
  {
    name: "background",
    classification: "workflow-tool-input",
    signature: "background?: boolean = true",
    options: [],
    constraints: [
      "background workflows are headless; use background false when checkpoint must show foreground confirmation",
    ],
  },
  {
    name: "maxAgents",
    classification: "workflow-tool-input",
    signature: "maxAgents?: number = 1000",
    options: [],
    constraints: [],
  },
  {
    name: "concurrency",
    classification: "workflow-tool-input",
    signature: "concurrency?: number",
    options: [],
    constraints: ["runtime clamps to 1..16"],
  },
  {
    name: "agentRetries",
    classification: "workflow-tool-input",
    signature: "agentRetries?: number = 0",
    options: [],
    constraints: ["floored and clamped to 0..3"],
  },
  {
    name: "agentTimeoutMs",
    classification: "workflow-tool-input",
    signature: "agentTimeoutMs?: number = 300000",
    options: [],
    constraints: ["null disables the hard timeout; default 300000ms (5min)"],
  },
  {
    name: "tokenBudget",
    classification: "workflow-tool-input",
    signature: "tokenBudget?: number",
    options: [],
    constraints: ["soft pre-call gate; in-flight work can overshoot"],
  },
  {
    name: "resumeFromRunId",
    classification: "workflow-tool-input",
    signature: "resumeFromRunId?: string",
    options: [],
    constraints: [
      "resumes a prior incomplete run with an edited script",
      "original args and execution limits are reused on resume",
      "unchanged positional calls replay from cache until the first changed call",
      "always runs in the background",
    ],
  },
  {
    name: "export const meta",
    classification: "script-contract",
    signature: "export const meta = { name, description, phases? }",
    options: [],
    constraints: [
      "must be the first statement",
      "name and description must be nonblank literals",
      "workflow meta and phase metadata cannot contain model or thinking fields",
      "spread, computed keys, methods, template interpolation, and __proto__/constructor/prototype are rejected",
    ],
  },
  {
    name: "determinism",
    classification: "script-contract",
    signature: "Date.now(), Math.random(), no-argument new Date() unavailable",
    options: [],
    constraints: ["pass timestamps and randomness through args"],
  },
];

/**
 * Every runtime global the script realm actually exposes. `check:capabilities`
 * asserts this set matches the declaration above, so a binding added to the
 * runtime but not documented fails the gate.
 */
export function declaredRuntimeGlobals(): string[] {
  return WORKFLOW_CAPABILITIES.filter((entry) => entry.classification === "runtime-global").map((entry) => entry.name);
}

/** Validate that the runtime's binding surface matches the contract. */
export function checkRuntimeBindings(bindings: WorkflowRuntimeBindings): string[] {
  const problems: string[] = [];
  const declared = new Set(declaredRuntimeGlobals());
  for (const name of declared) {
    if (!(name in bindings)) problems.push(`runtime is missing declared global "${name}"`);
  }
  for (const name of Object.keys(bindings) as Array<keyof WorkflowRuntimeBindings>) {
    if (!declared.has(name)) problems.push(`runtime exposes undocumented global "${String(name)}"`);
  }
  return problems;
}

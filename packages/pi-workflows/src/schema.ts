export const WORKFLOW_SCHEMA_VERSION = 1;

import type { WorkflowTier } from "@signalridge/pi-subagents-protocol";
export const MAX_TASKS = 128;
export const MAX_PHASES = 32;
export const MAX_TEXT = 100_000;
export const MAX_SHORT_TEXT = 512;

export interface WorkflowPhase {
  id: string;
  title: string;
}

export interface WorkflowTask {
  id: string;
  phase?: string;
  subagent_type: string;
  description: string;
  prompt: string;
  tier?: WorkflowTier;
  depends_on: string[];
  /**
   * Subset of `depends_on` whose journaled results are appended to this task's dispatch prompt.
   * Opt-in: absent means `depends_on` stays a pure ordering barrier, as it always has been.
   */
  inputs?: string[];
}

export interface WorkflowSynthesis {
  subagent_type: string;
  prompt: string;
  tier?: WorkflowTier;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  /** Default semantic tier for tasks and synthesis in this run. */
  tier?: WorkflowTier;
  phases: WorkflowPhase[];
  tasks: WorkflowTask[];
  synthesis?: WorkflowSynthesis;
  background: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return stringField(value, label, max);
}

function optionalTier(value: unknown, label: string): WorkflowTier | undefined {
  if (value === undefined) return undefined;
  if (value !== "small" && value !== "medium" && value !== "large") {
    throw new Error(`${label} must be one of small, medium, or large`);
  }
  return value;
}

function assertObjectKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field "${key}"`);
  }
}

function stringArray(value: unknown, label: string, maxItems: number, maxText: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxItems) throw new Error(`${label} has too many entries`);
  return value.map((item, index) => stringField(item, `${label}[${index}]`, maxText));
}

/**
 * `inputs` must be a duplicate-free subset of the same task's `depends_on`, so it can never
 * introduce an edge the cycle checker has not already seen.
 */
function validateTaskInputs(tasks: WorkflowTask[]): void {
  for (const task of tasks) {
    if (!task.inputs) continue;
    const dependencies = new Set(task.depends_on);
    const seen = new Set<string>();
    for (const input of task.inputs) {
      if (!dependencies.has(input)) {
        throw new Error(`task "${task.id}" input "${input}" is not one of its depends_on`);
      }
      if (seen.has(input)) throw new Error(`task "${task.id}" lists duplicate input "${input}"`);
      seen.add(input);
    }
  }
}

function validateDag(tasks: WorkflowTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`workflow dependencies contain a cycle at "${id}"`);
    if (visited.has(id)) return;
    visiting.add(id);
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`unknown dependency "${id}"`);
    for (const dependency of task.depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (!ids.has(dependency)) throw new Error(`task "${task.id}" depends on unknown task "${dependency}"`);
    }
    visit(task.id);
  }
}

/** Validate the strict declarative workflow input and return a normalized copy. */
export function validateWorkflow(input: unknown): WorkflowDefinition {
  if (!isRecord(input)) throw new Error("workflow must be an object");
  assertObjectKeys(input, ["name", "description", "tier", "phases", "tasks", "synthesis", "background"], "workflow");
  const name = stringField(input.name, "name", MAX_SHORT_TEXT);
  const description = optionalString(input.description, "description", MAX_TEXT);
  const tier = optionalTier(input.tier, "tier");

  const rawPhases = input.phases === undefined ? [] : input.phases;
  if (!Array.isArray(rawPhases)) throw new Error("phases must be an array");
  if (rawPhases.length > MAX_PHASES) throw new Error(`phases may contain at most ${MAX_PHASES} entries`);
  const phases = rawPhases.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`phases[${index}] must be an object`);
    assertObjectKeys(raw, ["id", "title"], `phases[${index}]`);
    return {
      id: stringField(raw.id, `phases[${index}].id`, 128),
      title: stringField(raw.title, `phases[${index}].title`, MAX_SHORT_TEXT),
    };
  });
  const phaseIds = new Set<string>();
  for (const phase of phases) {
    if (phaseIds.has(phase.id)) throw new Error(`duplicate phase id "${phase.id}"`);
    phaseIds.add(phase.id);
  }

  if (!Array.isArray(input.tasks)) throw new Error("tasks must be an array");
  if (input.tasks.length === 0) throw new Error("tasks must contain at least one task");
  if (input.tasks.length > MAX_TASKS) throw new Error(`tasks may contain at most ${MAX_TASKS} entries`);
  const taskIds = new Set<string>();
  const tasks = input.tasks.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`tasks[${index}] must be an object`);
    assertObjectKeys(
      raw,
      ["id", "phase", "tier", "subagent_type", "description", "prompt", "depends_on", "inputs"],
      `tasks[${index}]`,
    );
    const task: WorkflowTask = {
      id: stringField(raw.id, `tasks[${index}].id`, 128),
      phase: optionalString(raw.phase, `tasks[${index}].phase`, 128),
      tier: optionalTier(raw.tier, `tasks[${index}].tier`),
      subagent_type: stringField(raw.subagent_type, `tasks[${index}].subagent_type`, 128),
      description: stringField(raw.description, `tasks[${index}].description`, MAX_SHORT_TEXT),
      prompt: stringField(raw.prompt, `tasks[${index}].prompt`, MAX_TEXT),
      depends_on: stringArray(raw.depends_on, `tasks[${index}].depends_on`, MAX_TASKS, 128),
      // Spread so an absent field stays absent and journaled definitions remain byte-stable.
      ...(raw.inputs === undefined
        ? {}
        : { inputs: stringArray(raw.inputs, `tasks[${index}].inputs`, MAX_TASKS, 128) }),
    };
    if (taskIds.has(task.id)) throw new Error(`duplicate task id "${task.id}"`);
    taskIds.add(task.id);
    if (task.phase !== undefined && !phaseIds.has(task.phase)) {
      throw new Error(`task "${task.id}" references unknown phase "${task.phase}"`);
    }
    return task;
  });
  validateTaskInputs(tasks);
  validateDag(tasks);

  let synthesis: WorkflowSynthesis | undefined;
  if (input.synthesis !== undefined) {
    if (!isRecord(input.synthesis)) throw new Error("synthesis must be an object");
    assertObjectKeys(input.synthesis, ["subagent_type", "prompt", "tier"], "synthesis");
    const tier = optionalTier(input.synthesis.tier, "synthesis.tier");
    synthesis = {
      ...(tier === undefined ? {} : { tier }),
      subagent_type: stringField(input.synthesis.subagent_type, "synthesis.subagent_type", 128),
      prompt: stringField(input.synthesis.prompt, "synthesis.prompt", MAX_TEXT),
    };
  }

  if (input.background !== undefined && typeof input.background !== "boolean") {
    throw new Error("background must be a boolean");
  }
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(tier === undefined ? {} : { tier }),
    phases,
    tasks,
    ...(synthesis === undefined ? {} : { synthesis }),
    background: input.background ?? false,
  };
}

export function readyTaskIds(definition: WorkflowDefinition, completed: ReadonlySet<string>): string[] {
  return definition.tasks
    .filter((task) => !completed.has(task.id) && task.depends_on.every((dependency) => completed.has(dependency)))
    .map((task) => task.id);
}

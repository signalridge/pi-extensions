/**
 * Named, deterministic task-graph orchestration for workflow scripts.
 *
 * The script runtime deliberately keeps model/session policy in pi-subagents;
 * this module only schedules script callbacks. Tasks are executed in stable
 * declaration-order layers: all tasks whose dependencies completed form one
 * barrier, and the next layer is discovered only after that barrier settles.
 * That makes dynamic graphs replayable even when child agents finish in a
 * different order.
 */

export const MAX_ORCHESTRATION_TASKS = 128;
export const MAX_ORCHESTRATION_TASK_ID = 128;
export const MAX_ORCHESTRATION_PHASE = 512;
export const MAX_ORCHESTRATION_DESCRIPTION = 2_000;
export const MAX_ORCHESTRATION_RETRIES = 3;

export type OrchestrationErrorPolicy = "skip-dependents" | "continue" | "fail-fast";
export type OrchestrationTaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type OrchestrationTaskTerminalStatus = Exclude<OrchestrationTaskStatus, "pending" | "running">;

export interface OrchestrationTaskContext {
  readonly id: string;
  /** One-based attempt number for this task callback. */
  readonly attempt: number;
  /** Completed values plus null for failed/skipped dependencies. */
  readonly results: Readonly<Record<string, unknown>>;
  /** A detached status snapshot for every declared task. */
  readonly statuses: Readonly<Record<string, OrchestrationTaskStatus>>;
}

export interface OrchestrationTask {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly phase?: string;
  readonly description?: string;
  readonly retries: number;
  readonly run: (context: OrchestrationTaskContext) => unknown | Promise<unknown>;
}

export interface OrchestrationOptions {
  readonly onError: OrchestrationErrorPolicy;
}

export interface OrchestrationTaskResult {
  readonly id: string;
  readonly status: OrchestrationTaskTerminalStatus;
  /** Failed and skipped tasks expose null so downstream JSON is stable. */
  readonly value: unknown;
  readonly attempts: number;
  readonly error?: string;
}

export interface OrchestrationResult {
  /** Every task id appears once; failed/skipped values are null. */
  readonly results: Record<string, unknown>;
  /** Every task id appears once in declaration order. */
  readonly tasks: Record<string, OrchestrationTaskResult>;
}

export interface OrchestrationTaskEvent {
  readonly type: "task";
  readonly [key: string]: unknown;
  readonly stage: "start" | "retry" | "end" | "skip";
  readonly taskId: string;
  readonly phase?: string;
  readonly attempt: number;
  readonly status?: OrchestrationTaskTerminalStatus;
  readonly error?: string;
}

export interface OrchestrationHooks {
  /** Throw when the enclosing workflow has been cancelled. */
  readonly throwIfAborted?: () => void;
  /** Return true for infrastructure/fatal errors that must escape the graph. */
  readonly isFatal?: (error: unknown) => boolean;
  /** Render ordinary task failures into bounded diagnostics. */
  readonly formatError?: (error: unknown) => string;
  /** Observe task transitions; listener failures never affect scheduling. */
  readonly onEvent?: (event: OrchestrationTaskEvent) => void;
}

interface RawRecord {
  readonly [key: string]: unknown;
}

interface MutableTaskResult {
  readonly id: string;
  status: OrchestrationTaskStatus;
  value: unknown;
  attempts: number;
  error?: string;
  errorValue?: unknown;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedString(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > limit) throw new TypeError(`${label} exceeds ${limit} characters`);
  return normalized;
}

function readDependencies(raw: RawRecord, label: string): string[] {
  const hasCamel = Object.hasOwn(raw, "dependsOn");
  const hasSnake = Object.hasOwn(raw, "depends_on");
  if (hasCamel && hasSnake) throw new TypeError(`${label} cannot contain both dependsOn and depends_on`);
  const value = hasCamel ? raw.dependsOn : hasSnake ? raw.depends_on : undefined;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label}.dependsOn must be an array`);
  const dependencies: string[] = [];
  for (const [index, dependency] of value.entries()) {
    const normalized = readBoundedString(dependency, `${label}.dependsOn[${index}]`, MAX_ORCHESTRATION_TASK_ID);
    if (dependencies.includes(normalized)) throw new TypeError(`${label}.dependsOn repeats "${normalized}"`);
    dependencies.push(normalized);
  }
  return dependencies;
}

function readRetries(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_ORCHESTRATION_RETRIES) {
    throw new TypeError(`${label}.retries must be an integer from 0 to ${MAX_ORCHESTRATION_RETRIES}`);
  }
  return value;
}

function assertKnownKeys(raw: RawRecord, label: string): void {
  const allowed = new Set(["id", "dependsOn", "depends_on", "phase", "description", "retries", "run"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field "${key}"`);
  }
}

/** Validate and normalize a runtime task list without executing callbacks. */
export function normalizeOrchestration(
  rawTasks: unknown,
  rawOptions: unknown = undefined,
): { tasks: OrchestrationTask[]; options: OrchestrationOptions } {
  if (!Array.isArray(rawTasks)) throw new TypeError("orchestrate() expects an array of task objects");
  if (rawTasks.length > MAX_ORCHESTRATION_TASKS) {
    throw new TypeError(`orchestrate() accepts at most ${MAX_ORCHESTRATION_TASKS} tasks`);
  }

  const tasks: OrchestrationTask[] = [];
  const ids = new Set<string>();
  for (const [index, rawValue] of rawTasks.entries()) {
    const label = `orchestrate() task[${index}]`;
    if (!isRecord(rawValue)) throw new TypeError(`${label} must be an object`);
    assertKnownKeys(rawValue, label);
    const id = readBoundedString(rawValue.id, `${label}.id`, MAX_ORCHESTRATION_TASK_ID);
    if (id === "__proto__" || id === "constructor" || id === "prototype") {
      throw new TypeError(`${label}.id uses a reserved key name`);
    }
    if (ids.has(id)) throw new TypeError(`orchestrate() contains duplicate task id "${id}"`);
    ids.add(id);

    if (typeof rawValue.run !== "function") throw new TypeError(`${label}.run must be a function`);
    const dependsOn = readDependencies(rawValue, label);
    const phase =
      rawValue.phase === undefined
        ? undefined
        : readBoundedString(rawValue.phase, `${label}.phase`, MAX_ORCHESTRATION_PHASE);
    const description =
      rawValue.description === undefined
        ? undefined
        : readBoundedString(rawValue.description, `${label}.description`, MAX_ORCHESTRATION_DESCRIPTION);
    tasks.push({
      id,
      dependsOn,
      ...(phase === undefined ? {} : { phase }),
      ...(description === undefined ? {} : { description }),
      retries: readRetries(rawValue.retries, label),
      run: rawValue.run as OrchestrationTask["run"],
    });
  }

  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        throw new TypeError(`orchestrate() task "${task.id}" depends on unknown task "${dependency}"`);
      }
      if (dependency === task.id) throw new TypeError(`orchestrate() task "${task.id}" cannot depend on itself`);
    }
  }
  assertAcyclic(tasks);

  let onError: OrchestrationErrorPolicy = "skip-dependents";
  if (rawOptions !== undefined) {
    if (!isRecord(rawOptions)) throw new TypeError("orchestrate() options must be an object");
    for (const key of Object.keys(rawOptions)) {
      if (key !== "onError") throw new TypeError(`orchestrate() options contains unsupported field "${key}"`);
    }
    if (rawOptions.onError !== undefined) {
      if (
        rawOptions.onError !== "skip-dependents" &&
        rawOptions.onError !== "continue" &&
        rawOptions.onError !== "fail-fast"
      ) {
        throw new TypeError('orchestrate() options.onError must be "skip-dependents", "continue", or "fail-fast"');
      }
      onError = rawOptions.onError;
    }
  }
  return { tasks, options: { onError } };
}

function assertAcyclic(tasks: readonly OrchestrationTask[]): void {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, task.dependsOn.length);
    for (const dependency of task.dependsOn) {
      const list = dependents.get(dependency) ?? [];
      list.push(task.id);
      dependents.set(dependency, list);
    }
  }
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited !== tasks.length) throw new TypeError("orchestrate() task dependencies contain a cycle");
}

function terminal(status: OrchestrationTaskStatus | undefined): status is OrchestrationTaskTerminalStatus {
  return status === "completed" || status === "failed" || status === "skipped";
}

function defaultFormatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emit(hooks: OrchestrationHooks, event: OrchestrationTaskEvent): void {
  try {
    hooks.onEvent?.(event);
  } catch {
    // Observers are not part of execution correctness.
  }
}

function snapshotContext(
  task: OrchestrationTask,
  attempt: number,
  values: Record<string, unknown>,
  statuses: Record<string, OrchestrationTaskStatus>,
): OrchestrationTaskContext {
  let detachedResults: Record<string, unknown>;
  try {
    detachedResults = structuredClone(values);
  } catch (error: unknown) {
    throw new TypeError(
      `orchestrate() task "${task.id}" results cannot be detached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Object.freeze({
    id: task.id,
    attempt,
    results: Object.freeze(detachedResults),
    statuses: Object.freeze({ ...statuses }),
  });
}

/** Execute normalized tasks in deterministic dependency layers. */
export async function executeOrchestration(
  tasks: readonly OrchestrationTask[],
  options: OrchestrationOptions = { onError: "skip-dependents" },
  hooks: OrchestrationHooks = {},
): Promise<OrchestrationResult> {
  if (tasks.length > MAX_ORCHESTRATION_TASKS) {
    throw new TypeError(`orchestrate() accepts at most ${MAX_ORCHESTRATION_TASKS} tasks`);
  }
  const pending = new Set(tasks.map((task) => task.id));
  const values: Record<string, unknown> = {};
  const statuses: Record<string, OrchestrationTaskStatus> = {};
  const records = new Map<string, MutableTaskResult>();
  for (const task of tasks) {
    statuses[task.id] = "pending";
    // Keep pending tasks out of callback snapshots. The final `results` map is
    // filled separately so callers still receive one stable key per task.
    records.set(task.id, { id: task.id, status: "pending", value: null, attempts: 0 });
  }

  const markSkipped = (task: OrchestrationTask, reason: string): void => {
    const record = records.get(task.id);
    if (!record || !pending.has(task.id)) return;
    pending.delete(task.id);
    record.status = "skipped";
    record.value = null;
    record.error = reason;
    statuses[task.id] = "skipped";
    values[task.id] = null;
    emit(hooks, {
      type: "task",
      stage: "skip",
      taskId: task.id,
      ...(task.phase ? { phase: task.phase } : {}),
      attempt: 0,
      status: "skipped",
      error: reason,
    });
  };

  while (pending.size > 0) {
    hooks.throwIfAborted?.();

    if (options.onError !== "continue") {
      let propagatedSkip: boolean;
      do {
        propagatedSkip = false;
        for (const task of tasks) {
          if (!pending.has(task.id)) continue;
          const failedDependency = task.dependsOn.find((dependency) => {
            const status = statuses[dependency];
            return status === "failed" || status === "skipped";
          });
          if (failedDependency !== undefined) {
            markSkipped(task, `dependency "${failedDependency}" did not complete`);
            propagatedSkip = true;
          }
        }
      } while (propagatedSkip);
      if (pending.size === 0) break;
    }

    const ready = tasks.filter((task) => {
      if (!pending.has(task.id)) return false;
      return task.dependsOn.every((dependency) => {
        const status = statuses[dependency];
        return options.onError === "continue" ? terminal(status) : status === "completed";
      });
    });
    if (ready.length === 0) {
      throw new Error("orchestrate() could not make progress; check task dependencies and failure policy");
    }

    for (const task of ready) {
      const record = records.get(task.id);
      if (!record) continue;
      record.status = "running";
      statuses[task.id] = "running";
      emit(hooks, {
        type: "task",
        stage: "start",
        taskId: task.id,
        ...(task.phase ? { phase: task.phase } : {}),
        attempt: 1,
      });
    }

    const outcomes = await Promise.all(
      ready.map(async (task): Promise<{ task: OrchestrationTask; fatal?: { error: unknown } }> => {
        const record = records.get(task.id);
        if (!record) return { task };
        for (let attempt = 1; attempt <= task.retries + 1; attempt += 1) {
          record.attempts = attempt;
          try {
            hooks.throwIfAborted?.();
            const value = await task.run(snapshotContext(task, attempt, values, statuses));
            hooks.throwIfAborted?.();
            pending.delete(task.id);
            record.status = "completed";
            record.value = value === undefined ? null : value;
            statuses[task.id] = "completed";
            values[task.id] = record.value;
            emit(hooks, {
              type: "task",
              stage: "end",
              taskId: task.id,
              ...(task.phase ? { phase: task.phase } : {}),
              attempt,
              status: "completed",
            });
            return { task };
          } catch (error: unknown) {
            const fatal = hooks.isFatal?.(error) ?? false;
            const message = (hooks.formatError ?? defaultFormatError)(error);
            record.error = message;
            record.errorValue = error;
            if (fatal) {
              pending.delete(task.id);
              record.status = "failed";
              record.value = null;
              statuses[task.id] = "failed";
              values[task.id] = null;
              emit(hooks, {
                type: "task",
                stage: "end",
                taskId: task.id,
                ...(task.phase ? { phase: task.phase } : {}),
                attempt,
                status: "failed",
                error: message,
              });
              return { task, fatal: { error } };
            }
            if (attempt <= task.retries) {
              emit(hooks, {
                type: "task",
                stage: "retry",
                taskId: task.id,
                ...(task.phase ? { phase: task.phase } : {}),
                attempt,
                error: message,
              });
              continue;
            }
            pending.delete(task.id);
            record.status = "failed";
            record.value = null;
            statuses[task.id] = "failed";
            values[task.id] = null;
            emit(hooks, {
              type: "task",
              stage: "end",
              taskId: task.id,
              ...(task.phase ? { phase: task.phase } : {}),
              attempt,
              status: "failed",
              error: message,
            });
            return { task };
          }
        }
        return { task };
      }),
    );

    const fatal = outcomes.find((outcome) => outcome.fatal !== undefined)?.fatal;
    if (fatal) throw fatal.error;
    if (options.onError === "fail-fast") {
      const failed = ready.find((task) => records.get(task.id)?.status === "failed");
      if (failed) {
        const record = records.get(failed.id);
        throw record?.errorValue ?? new Error(record?.error ?? `orchestrate() task "${failed.id}" failed`);
      }
    }
  }

  const taskResults: Record<string, OrchestrationTaskResult> = {};
  for (const task of tasks) {
    const record = records.get(task.id);
    if (!record || !terminal(record.status)) continue;
    taskResults[task.id] = {
      id: task.id,
      status: record.status,
      value: record.value,
      attempts: record.attempts,
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }
  const outputResults: Record<string, unknown> = {};
  for (const task of tasks) outputResults[task.id] = values[task.id] ?? null;
  return { results: outputResults, tasks: taskResults };
}

/** Validate and execute a runtime task list in one call. */
export async function runOrchestration(
  rawTasks: unknown,
  rawOptions: unknown,
  hooks: OrchestrationHooks = {},
): Promise<OrchestrationResult> {
  const normalized = normalizeOrchestration(rawTasks, rawOptions);
  return executeOrchestration(normalized.tasks, normalized.options, hooks);
}

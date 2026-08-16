export type WorkflowStatus =
  | "pending"
  | "running"
  | "pausing"
  | "paused"
  | "synthesizing"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatching"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "blocked";

const workflowTransitions: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  pending: ["running", "stopping", "stopped"],
  running: ["pausing", "synthesizing", "stopping", "completed", "failed", "stopped", "interrupted"],
  pausing: ["paused", "stopping", "failed", "stopped", "interrupted"],
  paused: ["running", "stopping", "stopped", "interrupted"],
  synthesizing: ["stopping", "completed", "failed", "stopped", "interrupted"],
  stopping: ["completed", "failed", "stopped"],
  completed: [],
  failed: [],
  stopped: [],
  interrupted: ["running", "stopping", "stopped"],
};

/**
 * Every `WorkflowStatus`, derived from the exhaustive transition table rather than re-listed,
 * so a new union member cannot silently be omitted from status-driven enumerations.
 */
export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = Object.keys(workflowTransitions) as WorkflowStatus[];

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["ready", "blocked", "stopped"],
  ready: ["dispatching", "blocked", "stopped"],
  dispatching: ["ready", "queued", "running", "completed", "failed", "stopped", "blocked"],
  queued: ["ready", "running", "completed", "failed", "stopped"],
  running: ["ready", "completed", "failed", "stopped"],
  completed: [],
  failed: [],
  stopped: [],
  blocked: [],
};

export function canTransitionWorkflow(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return from === to || workflowTransitions[from].includes(to);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || taskTransitions[from].includes(to);
}

export function transitionWorkflow(from: WorkflowStatus, to: WorkflowStatus): WorkflowStatus {
  if (!canTransitionWorkflow(from, to)) throw new Error(`invalid workflow transition: ${from} -> ${to}`);
  return to;
}

export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransitionTask(from, to)) throw new Error(`invalid task transition: ${from} -> ${to}`);
  return to;
}

export function isTerminalWorkflow(status: WorkflowStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function isTerminalTask(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped" || status === "blocked";
}

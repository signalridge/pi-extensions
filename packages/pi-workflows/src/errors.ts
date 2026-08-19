/**
 * errors.ts — classified workflow failures.
 *
 * Every failure a workflow run can produce is narrowed here, so the engine,
 * journal, UI, and the capability contract can react to the same stable codes
 * instead of string-matching error text. `recoverable` is the single bit the
 * runtime and the engine key their retry/terminal decisions on.
 */

/** Stable runtime and persistence failure codes exposed to callers and UI surfaces. */
export enum WorkflowErrorCode {
  /** Agent exceeded timeout. */
  AGENT_TIMEOUT = "AGENT_TIMEOUT",
  /** Workflow was aborted by user. */
  WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
  /** Agent limit exceeded. */
  AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
  /** Token budget exhausted. */
  TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
  /**
   * The provider's subscription/usage/quota/rate limit was hit. Distinct from the
   * user's self-imposed TOKEN_BUDGET_EXHAUSTED: a provider limit refills on its own,
   * so the run is checkpointed (paused) and replayed by resume() rather than failed.
   */
  PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
  /** Script validation failed. */
  SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
  /** A schema agent never produced a valid structured result (after bounded repair). */
  SCHEMA_NONCOMPLIANCE = "SCHEMA_NONCOMPLIANCE",
  /** A non-schema agent completed without any assistant text output. */
  AGENT_EMPTY_OUTPUT = "AGENT_EMPTY_OUTPUT",
  /**
   * An agent()'s explicit selector (model/tier/agentType) did not resolve. Never
   * silently substituted — resolution is deterministic, so retrying the same spec
   * would fail identically every time.
   */
  MODEL_NOT_FOUND = "MODEL_NOT_FOUND",
  /** Agent execution failed. */
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
  /** Run state persistence failed. */
  PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
  /** Unknown error. */
  UNKNOWN = "UNKNOWN",
}

/** Classified workflow failure with recoverability and optional agent/provider context. */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly recoverable: boolean;
  readonly agentLabel?: string;
  readonly details?: unknown;
  /** For PROVIDER_USAGE_LIMIT: the provider's human reset hint, e.g. "Resets in ~3h" (verbatim). */
  readonly resetHint?: string;

  constructor(
    message: string,
    code: WorkflowErrorCode,
    options: { recoverable?: boolean; agentLabel?: string; details?: unknown; resetHint?: string } = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.agentLabel = options.agentLabel;
    this.details = options.details;
    this.resetHint = options.resetHint;
  }
}

/** Narrow an unknown failure to WorkflowError. */
export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}

/** Recognize abort-like Error messages without assuming a provider-specific class. */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}

/** Recognize timeout-like errors by name or message. */
export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\btimeout\b/i.test(error.message) || error.name === "TimeoutError";
}

/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 */
export function wrapError(error: unknown, context?: { agentLabel?: string }): WorkflowError {
  if (isWorkflowError(error)) return error;

  if (isAbortError(error)) {
    return new WorkflowError(
      error instanceof Error ? error.message : "Workflow was aborted",
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: true },
    );
  }

  if (isTimeoutError(error)) {
    return new WorkflowError(
      error instanceof Error ? error.message : "Agent timed out",
      WorkflowErrorCode.AGENT_TIMEOUT,
      { recoverable: true, agentLabel: context?.agentLabel },
    );
  }

  return new WorkflowError(
    error instanceof Error ? error.message : String(error),
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: true, agentLabel: context?.agentLabel, details: error },
  );
}

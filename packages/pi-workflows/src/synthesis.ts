import type { WorkflowRun, WorkflowTaskResult } from "./journal.js";
import type { WorkflowDefinition, WorkflowTask } from "./schema.js";

export const MAX_TASK_RESULT_CHARS = 6_000;
export const MAX_SYNTHESIS_INSTRUCTION_CHARS = 8_000;
export const MAX_SYNTHESIS_INPUT_CHARS = 48_000;
/** Aggregate budget for a task's `inputs` section; deliberately smaller than synthesis's. */
export const MAX_TASK_INPUT_CHARS = 24_000;
/** Must equal `boundedString`'s prompt cap in pi-subagents-protocol, which throws rather than truncating. */
export const MAX_DISPATCH_PROMPT_CHARS = 100_000;
/** Below this much headroom an input section carries no useful content, so none is injected. */
export const MIN_TASK_INPUT_CHARS = 512;
export const TASK_INPUT_HEADER = "Dependency results (pi-workflows inputs v1):";

export function cap(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  const marker = "\n…[truncated]";
  const contentLimit = Math.max(0, limit - marker.length);
  return { text: `${value.slice(0, contentLimit)}${marker}`, truncated: true };
}

export interface ResultEntry {
  task: Pick<WorkflowTask, "id" | "description">;
  result: WorkflowTaskResult | undefined;
  /** Reported as `status=` only when no journaled result exists. */
  fallbackStatus: string;
}

export interface BoundedSectionOptions {
  maxPerResult: number;
  maxTotal: number;
  overflowMarker: string;
}

/** One labeled, bounded result block. Reads only journaled fields so replays reproduce it exactly. */
export function buildResultBlock(entry: ResultEntry, maxResultChars = MAX_TASK_RESULT_CHARS): string {
  const { task, result } = entry;
  const bounded = cap(result?.text ?? "(no result)", maxResultChars);
  const pointers = [
    result?.agentId ? `agent_id=${result.agentId}` : "agent_id=unknown",
    result?.outputFile ? `transcript=${result.outputFile}` : undefined,
    result?.tokenCount !== undefined ? `token_count=${result.tokenCount}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  // `result.truncated` matters because `resultFromLifecycle` already caps text to
  // MAX_TASK_RESULT_CHARS, so a re-cap here can never observe the original overflow.
  const truncated = bounded.truncated || result?.truncated === true;
  return [
    `### ${task.id} — ${task.description}`,
    `status=${result?.status ?? entry.fallbackStatus} ${pointers}`,
    truncated ? "result_truncated=true" : "result_truncated=false",
    bounded.text,
  ].join("\n");
}

/** Append result blocks after `preamble` until the aggregate budget is reached. */
export function buildBoundedResultSection(
  preamble: readonly string[],
  entries: readonly ResultEntry[],
  options: BoundedSectionOptions,
): string {
  const chunks: string[] = [...preamble];
  let total = chunks.join("\n").length;
  let aggregateTruncated = false;

  for (const entry of entries) {
    const block = buildResultBlock(entry, options.maxPerResult);
    if (total + block.length + 2 > options.maxTotal) {
      aggregateTruncated = true;
      break;
    }
    chunks.push("", block);
    total += block.length + 2;
  }

  let output = chunks.join("\n");
  if (aggregateTruncated) {
    if (output.length + options.overflowMarker.length <= options.maxTotal) {
      output += options.overflowMarker;
    } else {
      output = `${output.slice(0, options.maxTotal - options.overflowMarker.length)}${options.overflowMarker}`;
    }
  }
  return output;
}

/** Build bounded, labeled synthesis context without concatenating full transcripts. */
export function buildSynthesisPrompt(
  definition: WorkflowDefinition,
  run: WorkflowRun,
  tasks: readonly WorkflowTask[] = definition.tasks,
): string {
  if (!definition.synthesis) throw new Error("workflow has no synthesis definition");

  const instruction = cap(definition.synthesis.prompt, MAX_SYNTHESIS_INSTRUCTION_CHARS);
  const entries = tasks.map((task) => ({
    task,
    result: run.taskResults[task.id],
    fallbackStatus: String(run.taskStatus[task.id]),
  }));
  const output = buildBoundedResultSection([instruction.text, "", "Workflow task results:"], entries, {
    maxPerResult: MAX_TASK_RESULT_CHARS,
    maxTotal: MAX_SYNTHESIS_INPUT_CHARS,
    overflowMarker: "\n\n[aggregate synthesis input truncated: additional task results omitted]",
  });
  return cap(output, MAX_SYNTHESIS_INPUT_CHARS).text;
}

export function resultFromLifecycle(
  status: "completed" | "failed" | "stopped",
  agentId: string | undefined,
  result: unknown,
  error: unknown,
  compactionCount: number,
  updatedAt = Date.now(),
  outputFile: unknown = undefined,
  tokenCount: unknown = undefined,
): WorkflowTaskResult {
  const raw = typeof result === "string" ? result : "";
  const bounded = cap(raw, MAX_TASK_RESULT_CHARS);
  const errorText = typeof error === "string" && error.length > 0 ? error.slice(0, 2_000) : undefined;
  const boundedOutputFile =
    typeof outputFile === "string" && outputFile.length > 0 ? outputFile.slice(0, 2_000) : undefined;
  const boundedTokenCount =
    typeof tokenCount === "number" && Number.isFinite(tokenCount) && tokenCount > 0
      ? Math.floor(tokenCount)
      : undefined;
  return {
    status,
    ...(agentId ? { agentId } : {}),
    ...(bounded.text ? { text: bounded.text } : {}),
    ...(errorText ? { error: errorText } : {}),
    ...(boundedOutputFile ? { outputFile: boundedOutputFile } : {}),
    ...(boundedTokenCount === undefined ? {} : { tokenCount: boundedTokenCount }),
    compactionCount,
    ...(bounded.truncated ? { truncated: true } : {}),
    updatedAt,
  };
}

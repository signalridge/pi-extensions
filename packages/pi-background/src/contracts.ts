export type JobStatus = "running" | "exited" | "failed" | "stopped" | "timed_out";
export type Attention = "turn" | "context" | "off";
export type Stream = "stdout" | "stderr";

export interface WatchOptions {
  patterns: string[];
  stream?: Stream | "both";
  repeat?: boolean;
  cooldownMs?: number;
  attention?: Exclude<Attention, "off">;
}

export interface StartOptions {
  command: string;
  cwd: string;
  description?: string;
  timeoutMs?: number;
  attention?: Attention;
  watch?: WatchOptions;
}

export interface JobSnapshot {
  id: string;
  command: string;
  cwd: string;
  description: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  attention: Attention;
  watch?: WatchOptions;
  droppedBytes: number;
}

export interface LogSnapshot {
  text: string;
  droppedBytes: number;
}

export interface JobEvent {
  jobId: string;
  description: string;
  kind: "exit" | "match";
  attention: Exclude<Attention, "off">;
  text: string;
}

export interface JobManager {
  /** Local UI invalidation only; never a model wake. Unsubscribe is idempotent. */
  subscribe(listener: () => void): () => void;
  /** Invocation-local synchronous guard, checked after stat and just before run dispatch. */
  start(options: StartOptions, signal?: AbortSignal, launchGuard?: () => void): Promise<JobSnapshot>;
  watch(id: string, options: WatchOptions): JobSnapshot;
  list(): JobSnapshot[];
  get(id: string): JobSnapshot;
  logs(id: string, tail?: number, stream?: Stream | "both"): LogSnapshot;
  stop(id: string): Promise<JobSnapshot>;
  clear(id?: string): number;
  shutdown(): Promise<void>;
}

export const LIMITS = {
  running: 8,
  retained: 32,
  logBytes: 256 * 1024,
  lineBytes: 8192,
  patterns: 8,
  patternChars: 256,
  timeoutMs: 24 * 60 * 60 * 1000,
  startupMs: 5000,
  notificationBytes: 8192,
  notificationJobs: 32,
  debounceMs: 1000,
  cooldownMs: 10_000,
} as const;

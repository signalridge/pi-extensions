import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  type JobEvent,
  type JobManager,
  type JobSnapshot,
  type JobStatus,
  LIMITS,
  type StartOptions,
  type WatchOptions,
} from "./contracts.js";
import { LogBuffer } from "./log-buffer.js";
import { Matcher, safeEventText, validateWatch } from "./matcher.js";
import { SUPERVISOR_SOURCE } from "./supervisor.js";

const KILL_GRACE_MS = 300;

interface Job {
  state: JobSnapshot;
  logs: LogBuffer;
  matcher?: Matcher;
  child: ChildProcess;
  spawned: boolean;
  closed: boolean;
  released: boolean;
  stopReason?: "stopped" | "timed_out";
  suppressExit: boolean;
  result?: { code: number | null; signal: string | null };
  timeout?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
}

function clone(state: JobSnapshot): JobSnapshot {
  return {
    ...state,
    watch: state.watch ? { ...state.watch, patterns: [...state.watch.patterns] } : undefined,
  };
}

function messageObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function abortError(): Error {
  const error = new Error("Background job startup aborted");
  error.name = "AbortError";
  return error;
}

function validateStart(options: StartOptions): StartOptions {
  if (typeof options.command !== "string" || !options.command.trim() || Buffer.byteLength(options.command) > 32768) {
    throw new Error("command must be nonempty and at most 32 KiB");
  }
  if (typeof options.cwd !== "string" || !options.cwd.trim()) throw new Error("cwd is required");
  if (
    options.description !== undefined &&
    (typeof options.description !== "string" || options.description.length > 200)
  ) {
    throw new Error("description must be at most 200 characters");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > LIMITS.timeoutMs)
  ) {
    throw new Error(`timeoutMs must be a positive integer no larger than ${LIMITS.timeoutMs}`);
  }
  if (options.attention !== undefined && !["turn", "context", "off"].includes(options.attention)) {
    throw new Error("Invalid attention");
  }
  return { ...options, watch: options.watch ? validateWatch(options.watch) : undefined };
}

/** In-memory, factory-local process ownership. Construction starts no resources. */
export function createJobManager(onEvent: (event: JobEvent) => void): JobManager {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("pi-background supports macOS and Linux only (win32 is unsupported)");
  }
  const jobs = new Map<string, Job>();
  const starting = new Set<Promise<JobSnapshot>>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        // UI invalidation cannot interrupt process supervision or other listeners.
      }
    }
  };
  let pending = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const emit = (event: JobEvent): void => {
    try {
      onEvent({ ...event, description: safeEventText(event.description), text: safeEventText(event.text) });
    } catch {
      // A UI/event subscriber must never take down the child IO handlers.
    }
  };
  const snapshot = (job: Job): JobSnapshot => clone({ ...job.state, droppedBytes: job.logs.droppedBytes });
  const requireJob = (id: string): Job => {
    const job = jobs.get(id);
    if (!job) throw new Error(`Unknown background job: ${id}`);
    return job;
  };
  const setWatch = (job: Job, options: WatchOptions): void => {
    const matcher = new Matcher(options, (pattern, line) => {
      // Stop/shutdown still drain logs, but cannot enqueue fresh watch wakes.
      // Result IPC can precede final stdout bytes: normal cleanup must not hide them.
      if (job.stopReason || shuttingDown) return;
      emit({
        jobId: job.state.id,
        description: job.state.description,
        kind: "match",
        attention: matcher.options.attention ?? "turn",
        text: `Matched ${pattern}: ${line}`,
      });
    });
    job.matcher = matcher;
    job.state.watch = { ...matcher.options, patterns: [...matcher.options.patterns] };
    changed();
  };
  const signalGroup = (job: Job, signal: NodeJS.Signals): void => {
    // Never address a group after observing its leader exit, or after releasing it.
    if (!job.spawned || job.closed || job.released || job.child.exitCode !== null || job.child.signalCode !== null)
      return;
    const pid = job.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        job.state.error = safeEventText(error instanceof Error ? error.message : String(error));
        changed();
      }
    }
  };
  const terminate = (job: Job, reason: "stopped" | "timed_out"): void => {
    if (job.closed) return;
    if (reason === "stopped") job.suppressExit = true;
    if (job.stopReason) return;
    job.stopReason = reason;
    job.state.status = reason;
    changed();
    clearTimeout(job.timeout);
    if (job.released) return;
    signalGroup(job, "SIGTERM");
    job.killTimer = setTimeout(() => signalGroup(job, "SIGKILL"), KILL_GRACE_MS);
  };
  const release = (job: Job): void => {
    if (job.released || job.stopReason || job.closed) return;
    // The command deadline ends at its result, not after our owned cleanup grace.
    clearTimeout(job.timeout);
    job.timeout = undefined;
    job.released = true;
    job.child.send({ kind: "release" }, (error) => {
      if (error && !job.closed) {
        // A lost IPC connection makes the helper kill its own group;
        // successful release keeps the leader alive through descendant cleanup.
        job.state.error = safeEventText(error.message);
        changed();
        if (job.child.connected) job.child.disconnect();
      }
    });
  };

  async function launch(options: StartOptions, signal?: AbortSignal, launchGuard?: () => void): Promise<JobSnapshot> {
    let reserved = true;
    try {
      const directory = await stat(options.cwd);
      launchGuard?.();
      if (!directory.isDirectory()) throw new Error("cwd must be a directory");
      if (signal?.aborted) throw abortError();
      if (shuttingDown) throw new Error("Background manager is shutting down");
      if (jobs.size >= LIMITS.retained) {
        let oldest: Job | undefined;
        for (const candidate of jobs.values()) {
          if (candidate.closed && (!oldest || (candidate.state.endedAt ?? 0) < (oldest.state.endedAt ?? 0))) {
            oldest = candidate;
          }
        }
        if (oldest) {
          jobs.delete(oldest.state.id);
          changed();
        } else throw new Error("Background history is full");
      }
      const child = spawn(process.versions.bun ? "node" : process.execPath, ["-e", SUPERVISOR_SOURCE], {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let finishDone: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        finishDone = resolve;
      });
      const job: Job = {
        state: {
          id: randomUUID(),
          command: options.command,
          cwd: options.cwd,
          description: options.description ?? options.command.slice(0, 200),
          status: "running",
          startedAt: Date.now(),
          pid: child.pid,
          attention: options.attention ?? "turn",
          droppedBytes: 0,
        },
        child,
        logs: new LogBuffer(),
        spawned: false,
        closed: false,
        released: false,
        suppressExit: false,
        done,
      };
      jobs.set(job.state.id, job);
      changed();
      pending--;
      reserved = false;
      if (options.watch) setWatch(job, options.watch);
      return await new Promise<JobSnapshot>((resolve, reject) => {
        let acknowledged = false;
        let startupError: Error | undefined;
        const failStartup = (error: Error): void => {
          if (acknowledged || startupError) return;
          startupError = error;
          job.suppressExit = true;
          job.stopReason = "stopped";
          job.state.status = "stopped";
          changed();
          clearTimeout(startupTimer);
          clearTimeout(job.killTimer);
          signalGroup(job, "SIGKILL");
        };
        const cancel = (): void =>
          failStartup(signal?.aborted ? abortError() : new Error("Background manager is shutting down"));
        const detachAbort = (): void => signal?.removeEventListener("abort", cancel);
        // Command timeouts begin only after its spawn acknowledgement. Bound
        // the separate helper handshake too (e.g. inherited inspect-brk flags).
        const startupTimer = setTimeout(() => {
          if (acknowledged || startupError) return;
          startupError = new Error("Background supervisor startup handshake timed out");
          job.state.error = startupError.message;
          job.suppressExit = true;
          job.stopReason = "stopped";
          job.state.status = "stopped";
          changed();
          signalGroup(job, "SIGKILL");
        }, LIMITS.startupMs);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        child.on("spawn", () => {
          job.spawned = true;
          job.state.pid = child.pid;
          if (startupError || shuttingDown) {
            cancel();
            signalGroup(job, "SIGKILL");
          } else if (job.stopReason) {
            signalGroup(job, "SIGTERM");
          }
        });
        child.stdout?.on("data", (chunk: Buffer) => {
          const text = job.logs.append("stdout", chunk);
          job.matcher?.feed("stdout", text);
          changed();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = job.logs.append("stderr", chunk);
          job.matcher?.feed("stderr", text);
          changed();
        });
        child.on("message", (value: unknown) => {
          const message = messageObject(value);
          if (!message) return;
          if (message.kind === "ready") {
            if (startupError || shuttingDown || job.stopReason) {
              cancel();
              signalGroup(job, "SIGKILL");
            } else {
              // The helper has no command yet. Revalidate the captured launch
              // owner/service after its asynchronous ready handshake, with no
              // await between this check and the irreversible run dispatch.
              try {
                launchGuard?.();
              } catch (error) {
                failStartup(error instanceof Error ? error : new Error(String(error)));
                return;
              }
              child.send({ kind: "run", command: options.command, cwd: options.cwd }, (error) => {
                if (!error) return;
                job.state.error = safeEventText(error.message);
                changed();
                signalGroup(job, "SIGKILL");
              });
            }
          } else if (message.kind === "spawned") {
            if (startupError || shuttingDown || job.stopReason) {
              cancel();
              signalGroup(job, "SIGKILL");
              return;
            }
            acknowledged = true;
            clearTimeout(startupTimer);
            detachAbort();
            job.state.startedAt = Date.now();
            if (options.timeoutMs !== undefined) {
              job.timeout = setTimeout(() => terminate(job, "timed_out"), options.timeoutMs);
            }
            changed();
            resolve(snapshot(job));
          } else if (message.kind === "failure" && typeof message.error === "string") {
            job.state.error = safeEventText(message.error);
            changed();
          } else if (
            message.kind === "result" &&
            (message.code === null || typeof message.code === "number") &&
            (message.signal === null || typeof message.signal === "string")
          ) {
            job.result = { code: message.code, signal: message.signal };
            release(job);
          }
        });
        child.on("error", (error) => {
          job.state.error = safeEventText(error.message);
          changed();
        });
        child.on("close", (code, childSignal) => {
          if (job.closed) return;
          job.closed = true;
          clearTimeout(startupTimer);
          clearTimeout(job.timeout);
          clearTimeout(job.killTimer);
          detachAbort();
          const stdoutEnd = job.logs.end("stdout");
          const stderrEnd = job.logs.end("stderr");
          job.matcher?.feed("stdout", stdoutEnd);
          job.matcher?.feed("stderr", stderrEnd);
          const result = job.result ?? { code, signal: childSignal };
          const status: JobStatus = job.stopReason ?? (job.state.error || result.code !== 0 ? "failed" : "exited");
          Object.assign(job.state, { status, exitCode: result.code, signal: result.signal, endedAt: Date.now() });
          if (status === "timed_out") job.state.error = "Job exceeded its timeout";
          if (status === "failed" && !job.state.error) {
            job.state.error = result.signal
              ? `Command terminated by ${result.signal}`
              : `Command exited with code ${result.code}`;
          }
          if (!job.suppressExit && job.state.attention !== "off") {
            emit({
              jobId: job.state.id,
              description: job.state.description,
              kind: "exit",
              attention: job.state.attention,
              text: `${status}: ${job.state.description}; code=${result.code}; signal=${result.signal}${job.state.error ? `; ${job.state.error}` : ""}`,
            });
          }
          changed();
          finishDone();
          if (!acknowledged) {
            if (startupError) reject(startupError);
            else resolve(snapshot(job));
          }
        });
      });
    } finally {
      if (reserved) pending--;
    }
  }

  const manager: JobManager = {
    subscribe(listener) {
      if (shuttingDown) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(options, signal, launchGuard) {
      if (shuttingDown) return Promise.reject(new Error("Background manager is shutting down"));
      let validated: StartOptions;
      try {
        validated = validateStart(options);
        if (signal?.aborted) throw abortError();
        if (pending + [...jobs.values()].filter((job) => !job.closed).length >= LIMITS.running) {
          throw new Error(`At most ${LIMITS.running} background jobs may run`);
        }
      } catch (error) {
        return Promise.reject(error);
      }
      pending++;
      const promise = launch(validated, signal, launchGuard);
      starting.add(promise);
      void promise.then(
        () => starting.delete(promise),
        () => starting.delete(promise),
      );
      return promise;
    },
    watch(id, options) {
      const job = requireJob(id);
      if (job.state.status !== "running") throw new Error("Can only watch a running job");
      setWatch(job, options);
      return snapshot(job);
    },
    list: () => [...jobs.values()].map(snapshot),
    get: (id) => snapshot(requireJob(id)),
    logs: (id, tail, stream) => requireJob(id).logs.snapshot(tail, stream),
    async stop(id) {
      const job = requireJob(id);
      terminate(job, "stopped");
      await job.done;
      return snapshot(job);
    },
    clear(id) {
      if (id !== undefined) {
        const job = requireJob(id);
        if (!job.closed) throw new Error("Cannot clear a running job");
        jobs.delete(id);
        changed();
        return 1;
      }
      let cleared = 0;
      for (const [jobId, job] of jobs) {
        if (!job.closed) continue;
        jobs.delete(jobId);
        cleared++;
      }
      if (cleared) changed();
      return cleared;
    },
    shutdown() {
      if (!shuttingDown) {
        shuttingDown = true;
        changed();
        listeners.clear();
      }
      if (!shutdownPromise) {
        for (const job of jobs.values()) terminate(job, "stopped");
        shutdownPromise = (async () => {
          await Promise.allSettled([...starting]);
          await Promise.all(
            [...jobs.values()].map(async (job) => {
              terminate(job, "stopped");
              await job.done;
            }),
          );
        })();
      }
      return shutdownPromise;
    },
  };
  return manager;
}

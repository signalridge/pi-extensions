// pi-herdr-state — resume-safe pi→herdr agent-status reporter.
//
// This replaces Herdr's bundled Pi integration while preserving the local
// reporter's subagent suppression, blocked-state support, socket retry,
// coalescing, and debug trace. It follows the Herdr 0.8 protocol-v8 wire
// contract: session binding is reported before state and every state report is
// tied to the same current session reference.
//
// Herdr grants authority to the source id, not the file: `remote/pi.toml` declares
// `aliases = ["herdr:pi"]`, so reporting as source "herdr:pi" keeps full authority
// even though the bundled hook file is uninstalled. Do NOT run
// `herdr integration install pi` alongside this — two reporters on source "herdr:pi"
// fight, so uninstall the bundled Pi integration before enabling this package.
//
// Tunables:
//   HERDR_PI_IDLE_DEBOUNCE_MS (default 250), HERDR_PI_POLL_MS (default 1000),
//   HERDR_PI_DEBUG=1 → append a trace to ~/.pi/agent/herdr-pi-state.log.

import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

type UnknownRecord = Record<string, unknown>;
type PiEventHandler = (...args: unknown[]) => void | Promise<void>;
type PiApi = {
  on: (event: string, handler: PiEventHandler) => void;
  events?: { on?: (event: string, handler: (data: unknown) => void) => void };
};

export type AgentState = "working" | "blocked" | "idle";
export type RequestTransport = (request: unknown) => Promise<void>;
export type SessionRef = { agent_session_path: string } | { agent_session_id: string };
export type SessionStartSource = "startup" | "resume" | "clear" | "compact" | "branch" | "new" | "fork" | "select";

function toRecord(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : {};
}

function callNoArg(value: unknown, receiver: unknown): unknown {
  return typeof value === "function" ? (value as () => unknown).call(receiver) : undefined;
}

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const isSubagentChild = process.env.PI_SUBAGENT_CHILD === "1";
const source = "herdr:pi";

const DEBUG = process.env.HERDR_PI_DEBUG === "1";
const logPath = join(homedir(), ".pi", "agent", "herdr-pi-state.log");
function log(...parts: unknown[]): void {
  if (!DEBUG) return;
  try {
    appendFileSync(logPath, `${new Date().toISOString()} [pid ${process.pid}] ${parts.join(" ")}\n`);
  } catch {
    /* ignore */
  }
}

function safeIdle(ctx: unknown): string {
  try {
    const context = toRecord(ctx);
    return String(callNoArg(context.isIdle, ctx));
  } catch {
    return "err";
  }
}

function parseDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const idleDebounceMs = parseDurationEnv("HERDR_PI_IDLE_DEBOUNCE_MS", 250);
const pollMs = parseDurationEnv("HERDR_PI_POLL_MS", 1000);

export function socketEndpointFor(configuredPath: string | undefined, platform = process.platform): string | undefined {
  if (!configuredPath) return undefined;
  if (platform !== "win32") return configuredPath;
  if (configuredPath.startsWith("\\\\.\\pipe\\")) return configuredPath;
  return `\\\\.\\pipe\\${configuredPath}`;
}

const socketEndpoint = socketEndpointFor(socketPath);

function enabled(): boolean {
  return HERDR_ENV === "1" && !!socketPath && !!socketEndpoint && !!paneId && !isSubagentChild;
}

log(`MODULE-EVAL pane=${paneId} enabled=${enabled()} child=${isSubagentChild} HERDR_ENV=${HERDR_ENV}`);

export function isAbsoluteSessionPath(value: unknown): value is string {
  return typeof value === "string" && (posix.isAbsolute(value) || win32.isAbsolute(value));
}

export function sessionRefFromValues(sessionFile: unknown, sessionId: unknown): SessionRef | undefined {
  if (isAbsoluteSessionPath(sessionFile)) {
    return { agent_session_path: sessionFile };
  }
  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    return { agent_session_id: sessionId };
  }
  return undefined;
}

export function normalizeSessionStartSource(reason: unknown): SessionStartSource | undefined {
  if (typeof reason !== "string") return undefined;
  const normalized = reason.trim().toLowerCase();
  const supported: readonly SessionStartSource[] = [
    "startup",
    "resume",
    "clear",
    "compact",
    "branch",
    "new",
    "fork",
    "select",
  ];
  return supported.includes(normalized as SessionStartSource) ? (normalized as SessionStartSource) : undefined;
}

export function withSessionRef(params: UnknownRecord, ref: SessionRef | undefined): UnknownRecord {
  return ref ? { ...params, ...ref } : params;
}

// ---- herdr socket plumbing (same wire protocol as the bundled integration) ----

// Sequence numbers are herdr's staleness gate: it drops any report whose seq is
// <= the last it saw for the pane. herdr resets a pane on session switch
// (/new, /resume) using a CURRENT wall-clock seq, so a fixed load-time base +1
// would be out-ranked and silently dropped afterward. Track current wall-clock
// each call so our reports always out-rank herdr's session-reset (and any other
// process sharing this pane, which all seed from the same clock).
let reportSeq = Date.now() * 1000;
function nextReportSeq(): number {
  reportSeq = Math.max(reportSeq + 1, Date.now() * 1000);
  return reportSeq;
}

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  if (!enabled()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(delivered);
    };
    const endpoint = socketEndpoint;
    if (!endpoint) {
      resolve(false);
      return;
    }
    const socket = createConnection(endpoint);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

async function sendRequestNow(request: unknown): Promise<void> {
  const body = toRecord(request);
  const method = body.method;
  const state = toRecord(body.params).state ?? "";
  try {
    if (await sendRequestAttempt(request, 500)) {
      log("SEND ok", method, state);
      return;
    }
    const ok = await sendRequestAttempt(request, 1500);
    log("SEND", ok ? "ok-retry" : "FAILED", method, state);
  } catch (error) {
    log("SEND exception", method, error);
  }
}

export function createRequestQueue(
  transport: RequestTransport,
  shouldSend: () => boolean = () => true,
): RequestTransport {
  let tail: Promise<void> = Promise.resolve();
  return (request: unknown): Promise<void> => {
    const deliver = () => (shouldSend() ? transport(request) : Promise.resolve());
    const next = tail.then(deliver, deliver);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

function readSessionRef(ctx: unknown): SessionRef | undefined {
  const sessionManager = toRecord(toRecord(ctx).sessionManager);
  let sessionFile: unknown;
  let sessionId: unknown;
  try {
    sessionFile = callNoArg(sessionManager.getSessionFile, sessionManager);
  } catch {
    sessionFile = undefined;
  }
  try {
    sessionId = callNoArg(sessionManager.getSessionId, sessionManager);
  } catch {
    sessionId = undefined;
  }
  // Read both values on every lifecycle event. A new or empty session must not
  // inherit the previous session's identity while its file is being created.
  return sessionRefFromValues(sessionFile, sessionId);
}

function sessionKey(ref: SessionRef | undefined): string | undefined {
  if (!ref) return undefined;
  if ("agent_session_path" in ref) return `path:${ref.agent_session_path}`;
  return `id:${ref.agent_session_id}`;
}

function reportSession(send: RequestTransport, reason: unknown, ref: SessionRef | undefined): Promise<void> {
  if (!ref) return Promise.resolve();
  const sessionStartSource = normalizeSessionStartSource(reason);
  return send({
    id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      seq: nextReportSeq(),
      ...(sessionStartSource ? { session_start_source: sessionStartSource } : {}),
      ...ref,
    },
  });
}

function reportState(
  send: RequestTransport,
  state: AgentState,
  message: string | undefined,
  ref: SessionRef | undefined,
): Promise<void> {
  return send({
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: withSessionRef(
      {
        pane_id: paneId,
        source,
        agent: "pi",
        state,
        message,
        seq: nextReportSeq(),
      },
      ref,
    ),
  });
}

function releaseAgent(send: RequestTransport): Promise<void> {
  return send({
    id: `${source}:release:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.release_agent",
    params: { pane_id: paneId, source, agent: "pi", seq: nextReportSeq() },
  });
}

export function createReporter(pi: PiApi, transport: RequestTransport = sendRequestNow): void {
  let disposed = false;
  const send = createRequestQueue(transport, () => !disposed);
  let active = false;
  let currentSession: SessionRef | undefined;
  let working = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let lastCtx: unknown;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const sessionTimers = new Set<ReturnType<typeof setTimeout>>();
  let lastReportedSessionKey: string | undefined;

  function desired(): AgentState {
    if (blockedCount > 0) return "blocked";
    return working ? "working" : "idle";
  }

  let queued: { state: AgentState; message?: string; ref?: SessionRef } | undefined;
  let sending = false;
  async function drain(): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      while (queued && !disposed) {
        const next = queued;
        queued = undefined;
        await reportState(send, next.state, next.message, next.ref);
      }
      if (disposed) queued = undefined;
    } finally {
      sending = false;
      if (queued && !disposed) void drain();
    }
  }

  function publish(force = false): void {
    if (!active || disposed) return;
    const state = desired();
    const message = state === "blocked" ? blockedMessage : undefined;
    if (!force && state === lastState && message === lastMessage) return;
    lastState = state;
    lastMessage = message;
    queued = { state, message, ref: currentSession };
    log("publish", state);
    if (!sending) void drain();
  }

  function sync(ctx: unknown): void {
    if (ctx) lastCtx = ctx;
    currentSession = readSessionRef(lastCtx);
  }

  function reportCurrentSession(reason: unknown, force: boolean): void {
    const ref = currentSession;
    const key = sessionKey(ref);
    if (!force && key === lastReportedSessionKey) return;
    lastReportedSessionKey = key;
    void reportSession(send, reason, ref);
  }

  function markWorking(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    working = true;
    publish();
  }

  function scheduleIdle(): void {
    if (disposed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (disposed) return;
      working = false;
      publish();
    }, idleDebounceMs);
    idleTimer.unref?.();
  }

  function clearTimers(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    for (const timer of sessionTimers) clearTimeout(timer);
    sessionTimers.clear();
    if (poll) {
      clearInterval(poll);
      poll = undefined;
    }
  }

  pi.on("session_start", (rawEvent: unknown, rawCtx: unknown) => {
    if (disposed) return;
    const event = toRecord(rawEvent);
    const ctx = toRecord(rawCtx);
    for (const timer of sessionTimers) clearTimeout(timer);
    sessionTimers.clear();
    sync(rawCtx);
    active = ctx.mode === "tui";
    log(`EVT session_start reason=${String(event.reason)} mode=${String(ctx.mode)} isIdle=${safeIdle(rawCtx)}`);
    if (!active) {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      log("session_start", event.reason, "mode is not tui -> inactive");
      return;
    }

    // This request is enqueued before publish(true), so it always reaches Herdr
    // before the first state report for this session.
    reportCurrentSession(event.reason, true);
    const idle = callNoArg(ctx.isIdle, rawCtx);
    working = idle === false;
    log("session_start", event.reason, "idle=", String(idle));
    publish(true);

    // herdr's session-switch reset (/new, /resume, /reload, /fork) is async and
    // drops source reports for a few seconds afterward. Re-assert the current
    // state a few times so herdr converges once its reset settles.
    if (event.reason && event.reason !== "startup") {
      for (const ms of [1200, 2800, 4800, 7000]) {
        const timer = setTimeout(() => {
          sessionTimers.delete(timer);
          if (!disposed && active) publish(true);
        }, ms);
        sessionTimers.add(timer);
        timer.unref?.();
      }
    }
  });

  // These are public Pi 0.84 lifecycle events. The extra per-turn signals keep
  // the local reporter responsive after a session rebind; agent_settled closes
  // the whole run after automatic retries/compaction have finished.
  for (const eventName of [
    "turn_start",
    "before_provider_request",
    "agent_start",
    "tool_execution_start",
    "message_start",
  ]) {
    pi.on(eventName, (_event: unknown, ctx: unknown) => {
      log("EVT", eventName, `active=${active}`, `isIdle=${safeIdle(ctx)}`);
      if (!active) return;
      sync(ctx);
      // Herdr's bundled integration refreshes the binding at agent_start. Keep
      // that behavior, and use the same queue before the first state report.
      reportCurrentSession(undefined, eventName === "agent_start");
      markWorking();
    });
  }

  for (const eventName of ["agent_end", "agent_settled"]) {
    pi.on(eventName, (_event: unknown, ctx: unknown) => {
      log("EVT", eventName, `active=${active}`, `isIdle=${safeIdle(ctx)}`);
      if (!active) return;
      sync(ctx);
      reportCurrentSession(undefined, false);
      scheduleIdle();
    });
  }

  // Blocked (e.g. permission/interview prompts) via the shared herdr event bus.
  pi.events?.on?.("herdr:blocked", (rawData: unknown) => {
    if (!active) return;
    const data = toRecord(rawData);
    if (!data.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
    } else {
      blockedCount += 1;
      blockedMessage = typeof data.label === "string" ? data.label : undefined;
    }
    publish();
  });

  pi.on("session_shutdown", async (rawEvent: unknown) => {
    if (disposed) return;
    const event = toRecord(rawEvent);
    const wasActive = active;
    clearTimers();
    active = false;
    queued = undefined;
    try {
      if (event.reason === "quit" && wasActive) {
        log("session_shutdown quit -> release");
        // Send release directly before enabling the disposed gate; replacement
        // shutdowns intentionally do not release process-owned Herdr authority.
        await releaseAgent(transport);
      } else {
        log("session_shutdown", event.reason, "-> dispose reporter");
      }
    } finally {
      disposed = true;
    }
  });

  // Reconciliation poll: re-assert event-driven state so a session switch or
  // delayed Herdr reset cannot leave the pane permanently stale.
  let pollTicks = 0;
  poll = setInterval(() => {
    pollTicks += 1;
    if (pollTicks % 5 === 0) {
      log(`poll-tick active=${active} working=${working} isIdle=${safeIdle(lastCtx)}`);
    }
    if (!active || disposed) return;
    if (pollTicks % 2 === 0) publish(true);
  }, pollMs);
  poll.unref?.();

  log(`loaded pane=${paneId}`);
}

export default function (pi: PiApi): void {
  if (!enabled()) {
    log("EXPORT-CALL skipped (enabled=false)");
    return;
  }
  log("EXPORT-CALL registering handlers on pi");
  createReporter(pi);
}

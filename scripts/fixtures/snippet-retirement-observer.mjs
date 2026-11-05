// Observation-only hooks for private diagnostic copies, never imported by production.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const OBSERVE_MS = 4000;
export function parseStat(raw) {
  // comm may contain spaces and parentheses. Fields after its LAST ')' are stable.
  const end = raw.lastIndexOf(")");
  if (end < 0 || !/^\d+ \(/.test(raw)) throw new Error("invalid proc stat");
  const fields = raw
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (fields.length < 20) throw new Error("short proc stat");
  return {
    pid: Number(raw.slice(0, raw.indexOf(" "))),
    state: fields[0],
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    starttime: fields[19],
  };
}

export function sameIdentity(first, next) {
  return Boolean(first && next && first.pid === next.pid && first.starttime === next.starttime);
}

export function disposition(snapshot) {
  if (snapshot.errno && !["ENOENT", "ESRCH"].includes(snapshot.errno)) return "unknown";
  if (snapshot.stat?.state === "Z" || snapshot.stat?.state === "X") return "zombie-or-dead";
  if (snapshot.stat) return "live";
  if (snapshot.errno === "ENOENT" || snapshot.errno === "ESRCH") return "absent";
  return "unknown"; // In particular, EPERM/EACCES is NOT evidence of disappearance.
}

export function canRescue(expected, observed, self) {
  return (
    Number.isSafeInteger(observed.pid) &&
    observed.pid > 1 &&
    observed.pid !== self &&
    observed.pid === observed.stat?.pid &&
    disposition(observed) === "live" &&
    Number.isSafeInteger(expected?.uid) &&
    expected.uid >= 0 &&
    expected.uid === observed.stat.uid &&
    expected.pgid > 1 &&
    expected.pgid === observed.stat.pgid &&
    expected.sid > 1 &&
    expected.sid === observed.stat.sid &&
    sameIdentity(expected, observed.stat)
  );
}

export function snapshot(pid) {
  const result = {
    pid,
    wall: new Date().toISOString(),
    monotonic: performance.now(),
    clockOrigin: performance.timeOrigin,
  };
  try {
    result.rawStat = readFileSync(`/proc/${pid}/stat`, "utf8");
    result.stat = parseStat(result.rawStat);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uids = status
      .match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m)
      ?.slice(1)
      .map(Number);
    if (!uids || new Set(uids).size !== 1) throw Object.assign(new Error("unconfirmed UID"), { code: "UNKNOWN" });
    result.stat.uid = uids[0];
    result.pending = Object.fromEntries(
      status
        .split("\n")
        .filter((line) => /^(SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):/.test(line))
        .map((line) => line.split(/:\s*/)),
    );
  } catch (error) {
    result.errno = error.code ?? "UNKNOWN";
  }
  result.disposition = disposition(result);
  return result;
}

export const pidfdHelperPath = fileURLToPath(new URL("./snippet-retirement-pidfd.py", import.meta.url));

export function invokePidfd(request) {
  const run = spawnSync(process.env.SNIPPET_DIAGNOSTIC_PYTHON ?? "python3", [pidfdHelperPath], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 16384,
  });
  if (run.error || run.status !== 0) return { status: "refused", reason: "pidfd helper failed" };
  try {
    const result = JSON.parse(run.stdout);
    return ["sent", "gone", "refused"].includes(result.status)
      ? result
      : { status: "refused", reason: "unknown helper result" };
  } catch {
    return { status: "refused", reason: "unreadable helper result" };
  }
}

// Both normal and watchdog rescue use this exact persisted-intent -> pidfd path.
// The helper opens a pidfd BEFORE its final identity read; never signal a number.
export function rescuePinned(expected, observed, record, prefix = "rescue", options = {}) {
  const self = options.self ?? process.pid;
  const forbidden = options.forbidden ?? [Number(process.env.SNIPPET_DIAGNOSTIC_SENTINEL)];
  if (
    !canRescue(expected, observed, self) ||
    forbidden.includes(observed.pid) ||
    forbidden.some((pid) => !Number.isSafeInteger(pid) || pid <= 1)
  ) {
    record(`${prefix}-refused`, { pid: observed.pid, reason: "identity or sentinel unconfirmed" });
    return false;
  }
  record(`${prefix}-intent`, { pid: observed.pid, signal: "SIGKILL", snapshot: observed });
  const result = (options.invoke ?? invokePidfd)({ expected, self, forbidden });
  record(`${prefix}-${result.status === "sent" ? "signal" : result.status}`, {
    pid: observed.pid,
    signal: "SIGKILL",
    transport: "pidfd",
    result,
  });
  return result.status === "sent" || result.status === "gone";
}

export function rescueKnown(known, items, record, prefix = "rescue", options = {}) {
  let confirmed = true;
  for (const item of items) {
    if (["absent", "zombie-or-dead"].includes(disposition(item))) continue;
    if (!rescuePinned(known.get(item.pid), item, record, prefix, options)) confirmed = false;
  }
  return confirmed;
}

const events = [];
const identities = new Map();
const supervisors = new Map();
let cleanupConfirmed = false;
let fixtureDirectory;
let naturalDeadline;
const evidence = process.env.SNIPPET_DIAGNOSTIC_EVIDENCE;

export function mark(kind, data = {}) {
  events.push({
    kind,
    wall: new Date().toISOString(),
    monotonic: performance.now(),
    clockOrigin: performance.timeOrigin,
    ...data,
  });
}

function flush() {
  if (!evidence) throw new Error("missing diagnostic evidence destination");
  appendFileSync(
    evidence,
    events
      .splice(0)
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
  );
}

export function registerPids(pids, cwd) {
  fixtureDirectory = cwd;
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("invalid fixture PID");
    if (!identities.has(pid)) {
      const initial = snapshot(pid);
      if (!initial.stat) throw new Error("cannot establish fixture PID identity");
      identities.set(pid, initial.stat);
      mark("fixture-identity", { snapshot: initial });
      flush();
    }
  }
  return pids;
}

export function supervisor(child) {
  if (!child.pid) return;
  const initial = snapshot(child.pid);
  // This is the just-created detached ChildProcess, not an arbitrary discovered PID.
  supervisors.set(child.pid, { child, initial: initial.stat, closed: false });
  mark("supervisor-spawn", { snapshot: initial });
  flush();
  child.once("exit", (code, signal) => mark("supervisor-exit", { pid: child.pid, code, signal }));
  child.once("close", (code, signal) => {
    supervisors.get(child.pid).closed = true;
    mark("supervisor-close", { pid: child.pid, code, signal });
  });
}

export function retire(name, call) {
  mark("retire-call", { name });
  const pending = call();
  // Return the SAME promise; this does not add a new awaited barrier.
  pending?.then(
    () => {
      naturalDeadline ??= performance.now() + OBSERVE_MS;
      mark("retire-return", { name });
    },
    (error) => mark("retire-reject", { name, message: error.message }),
  );
  return pending;
}

// Execute the original predicate FIRST. Extra /proc reads or writes must not hide
// its result. The original catch-all and exact zombie regex are retained as data.
export function alive(pid) {
  let result = false;
  let rawStat;
  let errno;
  const monotonic = performance.now();
  const wall = new Date().toISOString();
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      rawStat = readFileSync(`/proc/${pid}/stat`, "utf8");
      result = !/^\d+ \(.*\) Z /.test(rawStat);
    } else result = true;
  } catch (error) {
    errno = error.code ?? "UNKNOWN";
  }
  events.push({
    kind: "alive-predicate",
    pid,
    result,
    rawStat,
    errno,
    monotonic,
    wall,
    evaluated: performance.now(),
    clockOrigin: performance.timeOrigin,
  });
  return result;
}

function allSnapshots() {
  return [...new Set([...identities.keys(), ...supervisors.keys()])].map(snapshot);
}

export function ready() {
  // Also record the waiting shell by walking ONLY the known fixture ancestry to
  // our own detached supervisor. Never discover arbitrary process groups to kill.
  for (const first of [...identities.values()]) {
    let current = snapshot(first.pid);
    const chain = [];
    for (let i = 0; i < 4 && current.stat && !supervisors.has(current.pid); i++) {
      chain.push(current);
      current = snapshot(current.stat.ppid);
    }
    if (current.stat && supervisors.has(current.pid)) {
      for (const item of chain) {
        if (item.stat.pgid !== current.pid || item.stat.sid !== current.pid) throw new Error("fixture escaped group");
        identities.set(item.pid, item.stat);
      }
    }
  }
  mark("fixture-ready", { snapshots: allSnapshots() });
  flush();
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
const quiet = (items) => items.every((item) => ["absent", "zombie-or-dead"].includes(item.disposition));

export async function cleanup(pids, cwd) {
  registerPids(pids, cwd);
  mark("pre-rescue-observation-start", { snapshots: allSnapshots() });
  flush(); // Persist all identities and raw evidence BEFORE any fixture rescue.
  // Candidate's existing gone() observation shares this budget; never grant it
  // a second four-second window after that observation has already failed.
  const deadline = naturalDeadline ?? performance.now() + OBSERVE_MS;
  let previous;
  let last;
  do {
    last = allSnapshots();
    const signature = JSON.stringify(
      last.map((item) => [item.pid, item.disposition, item.stat?.state, item.stat?.starttime, item.errno]),
    );
    if (signature !== previous) {
      mark("natural-observation", { snapshots: last });
      flush();
      previous = signature;
    }
    if (quiet(last)) break;
    await pause();
  } while (performance.now() < deadline);
  mark("pre-rescue-observation-end", { snapshots: last, natural: quiet(last) });
  flush();
  let rescueConfirmed = true;
  if (!quiet(last)) {
    mark("rescue-start", { snapshots: allSnapshots() });
    flush();
    // No group or numeric-PID rescue signals. Persist intent before the helper
    // acquires a pidfd, validates identity, and signals only that held handle.
    const known = new Map([...supervisors].map(([pid, item]) => [pid, item.initial]));
    for (const [pid, identity] of identities) known.set(pid, identity);
    rescueConfirmed = rescueKnown(known, allSnapshots(), (kind, data) => {
      mark(kind, data);
      flush(); // Intent is durable BEFORE helper acquisition/read/send.
    });
    const rescueDeadline = performance.now() + 1000;
    while (!quiet(allSnapshots()) && performance.now() < rescueDeadline) await pause();
  }
  // Direct ChildProcess handles must close (reap); orphan zombies are separately
  // reported, not described as live and not claimed to have been reaped here.
  const reapDeadline = performance.now() + 1000;
  while ([...supervisors.values()].some((item) => !item.closed) && performance.now() < reapDeadline) await pause();
  const final = allSnapshots();
  cleanupConfirmed = rescueConfirmed && quiet(final) && [...supervisors.values()].every((item) => item.closed);
  mark("cleanup-result", { confirmed: cleanupConfirmed, snapshots: final });
  flush();
  // Bun test does not reliably dispatch the normal process 'exit' hook. Persist
  // the authoritative cleanup result here, not only in that optional hook.
  writeFileSync(`${evidence}.cleanup.json`, JSON.stringify({ cleanupConfirmed }));
  if (!cleanupConfirmed) throw new Error("diagnostic cleanup unconfirmed; abort subsequent rounds");
  rmSync(cwd, { recursive: true, force: true });
}

process.on("exit", () => {
  // Small, narrow artifact only: no environment, commands, output, or user files.
  if (evidence) {
    mark("observer-exit", { cleanupConfirmed, fixtureCreated: Boolean(fixtureDirectory) });
    flush();
    writeFileSync(`${evidence}.cleanup.json`, JSON.stringify({ cleanupConfirmed }));
  }
});

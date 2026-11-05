import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JobEvent, type JobManager, LIMITS } from "../src/contracts.js";
import { createJobManager } from "../src/manager.js";

const managers: JobManager[] = [];
const cwd = tmpdir();
function manager(events: JobEvent[] = []): JobManager {
  const instance = createJobManager((event) => events.push(event));
  managers.push(instance);
  return instance;
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function finished(instance: JobManager, id: string): Promise<void> {
  await until(() => instance.get(id).endedAt !== undefined);
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.shutdown()));
  vi.restoreAllMocks();
});

describe("job manager", () => {
  it("acknowledges spawn, drains UTF-8/stdout/stderr, retains exit state, and emits once", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const job = await instance.start({
      command: "printf '\\360\\237'; sleep .02; printf '\\230\\200\\n'; printf 'error\\n' >&2; exit 7",
      cwd,
    });
    expect(job.status).toBe("running");
    expect(job.pid).toBeGreaterThan(0);
    await finished(instance, job.id);
    expect(instance.get(job.id)).toMatchObject({ status: "failed", exitCode: 7, signal: null });
    expect(instance.logs(job.id, 200, "stdout").text).toBe("😀\n");
    expect(instance.logs(job.id, 200, "stderr").text).toBe("error\n");
    expect(events.filter((event) => event.kind === "exit")).toHaveLength(1);
    expect(events[0].text).toContain("code=7");
    expect(instance.clear(job.id)).toBe(1);
    expect(() => instance.get(job.id)).toThrow("Unknown");
  });

  it("returns one failed state/event for helper spawn error plus close", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const executable = process.execPath;
    try {
      process.execPath = "/nonexistent-background-node";
      const job = await instance.start({ command: "true", cwd });
      expect(job.status).toBe("failed");
      expect(job.error).toContain("ENOENT");
      expect(job.endedAt).toBeDefined();
      expect(events.filter((event) => event.kind === "exit")).toHaveLength(1);
    } finally {
      process.execPath = executable;
    }
  });

  it("cleans an abort after creating the detached helper", async () => {
    const instance = manager();
    const controller = new AbortController();
    const start = instance.start({ command: "sleep 20", cwd }, controller.signal);
    const observed = start.catch((error: unknown) => error);
    // setImmediate lets stat/spawn run but does not wait for the helper handshake.
    const deadline = Date.now() + 5000;
    while (instance.list().length === 0) {
      if (Date.now() > deadline) throw new Error("Helper was not created");
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    expect(await observed).toMatchObject({ name: "AbortError" });
    const job = instance.list()[0];
    expect(job.status).toBe("stopped");
    expect(job.endedAt).toBeDefined();
    if (job.pid !== undefined) expect(() => process.kill(job.pid ?? 0, 0)).toThrow();
  });

  it("shuts down a helper already spawned but still in its startup handshake", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const start = instance.start({ command: "sleep 20", cwd });
    const observed = start.catch(() => undefined);
    const deadline = Date.now() + 5000;
    while (instance.list().length === 0) {
      if (Date.now() > deadline) throw new Error("Helper was not created");
      await new Promise((resolve) => setImmediate(resolve));
    }
    await instance.shutdown();
    await observed;
    const job = instance.list()[0];
    expect(job.status).toBe("stopped");
    expect(job.endedAt).toBeDefined();
    if (job.pid !== undefined) expect(() => process.kill(job.pid ?? 0, 0)).toThrow();
    expect(events).toHaveLength(0);
  });

  it("bounds a helper stalled before handshake and releases its admission slot", async () => {
    const instance = manager();
    const events: JobEvent[] = [];
    const stalled = manager(events);
    const previous = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = "--inspect-brk=0";
      await expect(stalled.start({ command: "echo must-not-run", cwd })).rejects.toThrow("handshake timed out");
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
    const helper = stalled.list()[0];
    expect(helper.endedAt).toBeDefined();
    expect(helper.error).toContain("handshake timed out");
    expect(stalled.logs(helper.id).text).not.toContain("must-not-run");
    expect(() => process.kill(helper.pid ?? 0, 0)).toThrow();
    expect(events).toHaveLength(0);
    const recovered = await stalled.start({ command: "echo recovered", cwd });
    await finished(stalled, recovered.id);
    expect(stalled.logs(recovered.id).text).toBe("recovered\n");
    expect(instance.list()).toHaveLength(0);
  }, 10000);

  it("uses local bash builtins and reports command signals faithfully", async () => {
    const instance = manager();
    const builtin = await instance.start({ command: "printf '%s' \"$BASH_VERSION\"", cwd, attention: "off" });
    await finished(instance, builtin.id);
    expect(instance.get(builtin.id).status).toBe("exited");
    expect(instance.logs(builtin.id).text).toMatch(/^\d+\./);
    const signal = await instance.start({ command: "kill -TERM $$", cwd });
    await finished(instance, signal.id);
    expect(instance.get(signal.id)).toMatchObject({ status: "failed", exitCode: null, signal: "SIGTERM" });
  });

  it("validates admission before executing and reserves concurrent startup slots", async () => {
    const instance = manager();
    for (const command of ["", "  ", "x".repeat(32769)]) {
      await expect(instance.start({ command, cwd })).rejects.toThrow("command");
    }
    for (const timeoutMs of [0, -1, 0.1, Infinity, LIMITS.timeoutMs + 1]) {
      await expect(instance.start({ command: "true", cwd, timeoutMs })).rejects.toThrow("timeoutMs");
    }
    await expect(instance.start({ command: "true", cwd, description: "x".repeat(201) })).rejects.toThrow("description");
    await expect(instance.start({ command: "true", cwd: "/nonexistent-background-directory" })).rejects.toThrow();
    const file = join(await mkdtemp(join(tmpdir(), "background-test-")), "file");
    try {
      await writeFile(file, "file");
      await expect(instance.start({ command: "true", cwd: file })).rejects.toThrow("directory");
    } finally {
      await rm(join(file, ".."), { recursive: true, force: true });
    }
    const starts = Array.from({ length: 8 }, () => instance.start({ command: "sleep 20", cwd }));
    await expect(instance.start({ command: "true", cwd })).rejects.toThrow("At most 8");
    const jobs = await Promise.all(starts);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(8);
    expect(instance.list()).toHaveLength(8);
    expect(() => instance.clear(jobs[0].id)).toThrow("running");
  });

  it("aborts startup without executing early-aborted commands and detaches successful start signals", async () => {
    const instance = manager();
    const folder = await mkdtemp(join(tmpdir(), "background-abort-"));
    try {
      const controller = new AbortController();
      const pending = instance.start({ command: "touch marker", cwd: folder }, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      const early = new AbortController();
      early.abort();
      await expect(instance.start({ command: "touch marker", cwd: folder }, early.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      const probe = await instance.start({ command: "test ! -e marker", cwd: folder });
      await finished(instance, probe.id);
      expect(instance.get(probe.id).exitCode).toBe(0);
      const lifetime = new AbortController();
      const job = await instance.start({ command: "sleep .1; echo survived", cwd }, lifetime.signal);
      lifetime.abort();
      await finished(instance, job.id);
      expect(instance.logs(job.id).text).toContain("survived");
      expect(instance.get(job.id).status).toBe("exited");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("attaches/replaces watches and clones snapshots, bounding logs", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const job = await instance.start({
      command: "sleep .15; printf 'ready\\nready\\n'; sleep .15; printf 'ready\\n'; sleep .2",
      cwd,
    });
    const watch = { patterns: ["ready"] };
    const snapshot = instance.watch(job.id, watch);
    watch.patterns[0] = "mutated";
    snapshot.watch?.patterns.push("also-mutated");
    await until(() => events.some((event) => event.kind === "match"));
    expect(events.filter((event) => event.kind === "match")).toHaveLength(1);
    expect(instance.get(job.id).watch?.patterns).toEqual(["ready"]);
    instance.watch(job.id, { patterns: ["ready"] });
    await finished(instance, job.id);
    expect(events.filter((event) => event.kind === "match")).toHaveLength(2);
    expect(() => instance.watch(job.id, { patterns: ["ready"] })).toThrow("running");
    const large = await instance.start({ command: "printf '%300000s' x; printf '%300000s' y >&2", cwd });
    await finished(instance, large.id);
    const logs = instance.logs(large.id);
    expect(Buffer.byteLength(logs.text)).toBeLessThanOrEqual(LIMITS.logBytes);
    expect(logs.droppedBytes).toBe(600000 - LIMITS.logBytes);
  });

  it("sanitizes fragmented DCS/C1 event excerpts without changing retained decoded logs", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const chunks = ["\x1bPq\x07hidden", "\x1b", "\\\x9dtitle", "\x9cready 😀\n"];
    const script = `const chunks=${JSON.stringify(chunks)};let i=0;const timer=setInterval(()=>{process.stdout.write(chunks[i++]);if(i===chunks.length)clearInterval(timer)},20)`;
    const job = await instance.start({
      command: `${quote(process.execPath)} -e ${quote(script)}`,
      cwd,
      attention: "off",
      watch: { patterns: ["ready"] },
    });
    await finished(instance, job.id);
    expect(instance.logs(job.id).text).toBe(chunks.join(""));
    expect(events).toEqual([expect.objectContaining({ kind: "match", text: "Matched ready: ready 😀" })]);
  });

  it("repeats real per-line matches only after cooldown and honors stream filters", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const job = await instance.start({
      command: "printf 'ready\\n'; printf 'ready\\nready\\n' >&2; sleep 1.1; printf 'ready\\n' >&2",
      cwd,
      attention: "off",
      watch: { patterns: ["ready"], stream: "stderr", repeat: true, cooldownMs: 1000 },
    });
    await finished(instance, job.id);
    expect(events.map((event) => event.kind)).toEqual(["match", "match"]);
  });

  it("times out once, waits for close on concurrent stop, and suppresses manual exit wake", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const timed = await instance.start({ command: "sleep 20", cwd, timeoutMs: 30 });
    await finished(instance, timed.id);
    expect(instance.get(timed.id)).toMatchObject({ status: "timed_out", error: "Job exceeded its timeout" });
    expect(events.filter((event) => event.jobId === timed.id && event.kind === "exit")).toHaveLength(1);
    const manual = await instance.start({ command: "sleep 20", cwd });
    const [first, second] = await Promise.all([instance.stop(manual.id), instance.stop(manual.id)]);
    expect(first).toEqual(second);
    expect(first.status).toBe("stopped");
    expect(first.endedAt).toBeDefined();
    expect(events.filter((event) => event.jobId === manual.id && event.kind === "exit")).toHaveLength(0);
  });

  it("kills a TERM-ignoring descendant even when the command shell exits immediately", async () => {
    const instance = manager();
    const script = 'process.on("SIGTERM",()=>{}); console.log(process.pid); setInterval(()=>{},1000)';
    const job = await instance.start({ command: `${quote(process.execPath)} -e ${quote(script)} & wait`, cwd });
    await until(() => /^\d+\n/.test(instance.logs(job.id).text));
    const descendant = Number(instance.logs(job.id).text.trim());
    const stopping = instance.stop(job.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The original shell has received TERM, but the leader and ignoring child
    // must remain alive (and therefore the PGID remains owned) during grace.
    expect(() => process.kill(job.pid ?? 0, 0)).not.toThrow();
    expect(() => process.kill(descendant, 0)).not.toThrow();
    const stopped = await stopping;
    expect(stopped.status).toBe("stopped");
    expect(() => process.kill(job.pid ?? 0, 0)).toThrow();
    await until(() => {
      try {
        process.kill(descendant, 0);
        // Some Linux containers keep dead orphan zombies; no live execution remains.
        return execFileSync("ps", ["-o", "stat=", "-p", String(descendant)], { encoding: "utf8" })
          .trim()
          .startsWith("Z");
      } catch {
        return true;
      }
    });
  });

  it("matches final decoder output after normal completion instead of dropping its watch", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const job = await instance.start({
      command: "printf '\\342'",
      cwd,
      attention: "off",
      watch: { patterns: ["�"], attention: "turn" },
    });
    await finished(instance, job.id);
    expect(instance.logs(job.id).text).toBe("�");
    expect(events).toEqual([
      expect.objectContaining({ kind: "match", text: expect.stringContaining("�"), attention: "turn" }),
    ]);
  });

  it("does not charge normal group cleanup grace to the command timeout", async () => {
    const instance = manager();
    const job = await instance.start({ command: "printf complete", cwd, timeoutMs: 250 });
    await finished(instance, job.id);
    expect(instance.get(job.id)).toMatchObject({ status: "exited", exitCode: 0, signal: null });
    expect(instance.logs(job.id).text).toBe("complete");
  });

  it("cleans same-group redirected descendants on successful command completion", async () => {
    const instance = manager();
    const folder = await mkdtemp(join(tmpdir(), "background-descendant-"));
    const marker = join(folder, "child.pid");
    try {
      const script = `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
      const job = await instance.start({
        command: `${quote(process.execPath)} -e ${quote(script)} >/dev/null 2>&1 & while [ ! -s ${quote(marker)} ]; do sleep .01; done; printf finished`,
        cwd,
      });
      await finished(instance, job.id);
      expect(instance.get(job.id)).toMatchObject({ status: "exited", exitCode: 0, signal: null });
      expect(instance.logs(job.id).text).toBe("finished");
      const descendant = Number(await readFile(marker, "utf8"));
      await until(() => {
        try {
          process.kill(descendant, 0);
          return execFileSync("ps", ["-o", "stat=", "-p", String(descendant)], { encoding: "utf8" })
            .trim()
            .startsWith("Z");
        } catch {
          return true;
        }
      });
      expect(() => process.kill(job.pid ?? 0, 0)).toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.each([undefined, 200])(
    "cleans inherited pipes on shell exit without charging cleanup to timeout %s",
    async (timeoutMs) => {
      const events: JobEvent[] = [];
      const instance = manager(events);
      const folder = await mkdtemp(join(tmpdir(), "background-inherited-pipe-"));
      const marker = join(folder, "child.pid");
      try {
        // Exercise inherited pipes and TERM drainage, not a second Node cold
        // startup inside the command's deliberately short 200ms deadline.
        const script = `trap 'printf "TERM-drained\\n"' TERM; printf '%s' "$$" > ${quote(marker)}; printf 'inherited\\n'; while :; do sleep 1; done`;
        const job = await instance.start({
          command: `/bin/sh -c ${quote(script)} & while [ ! -s ${quote(marker)} ]; do sleep .01; done; printf 'shell-complete\\n'`,
          cwd,
          timeoutMs,
        });
        await finished(instance, job.id);
        const descendant = Number(await readFile(marker, "utf8"));
        expect(instance.get(job.id)).toMatchObject({ status: "exited", exitCode: 0, signal: null });
        expect(instance.logs(job.id).text).toContain("shell-complete\n");
        expect(instance.logs(job.id).text).toContain("TERM-drained\n");
        expect(events.filter((event) => event.kind === "exit")).toHaveLength(1);
        expect(() => process.kill(job.pid ?? 0, 0)).toThrow();
        await until(() => {
          try {
            process.kill(descendant, 0);
            return execFileSync("ps", ["-o", "stat=", "-p", String(descendant)], { encoding: "utf8" })
              .trim()
              .startsWith("Z");
          } catch {
            return true;
          }
        });
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  );

  it("retains termination logs without waking watched literals after intentional stop", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const script =
      'process.on("SIGTERM",()=>console.log("shutdown-marker"));console.log("started");setInterval(()=>{},1000)';
    const job = await instance.start({
      command: `${quote(process.execPath)} -e ${quote(script)}`,
      cwd,
      watch: { patterns: ["shutdown-marker"] },
    });
    await until(() => instance.logs(job.id).text.includes("started"));
    await instance.stop(job.id);
    expect(instance.logs(job.id).text).toContain("shutdown-marker");
    expect(events).toEqual([]);
  });

  it("shuts admission synchronously, including in-flight starts; factories are isolated", async () => {
    const events: JobEvent[] = [];
    const one = manager(events);
    const two = manager();
    const job = await two.start({ command: "sleep .1; echo other", cwd });
    await one.start({ command: "sleep 20", cwd });
    const start = one.start({ command: "sleep 20", cwd });
    const observed = start.catch(() => undefined);
    const shutdown = one.shutdown();
    await expect(one.start({ command: "true", cwd })).rejects.toThrow("shutting down");
    expect(one.shutdown()).toBe(shutdown);
    await shutdown;
    await observed;
    expect(one.list().every((entry) => entry.endedAt !== undefined)).toBe(true);
    expect(events).toHaveLength(0);
    await finished(two, job.id);
    expect(two.logs(job.id).text).toBe("other\n");
    expect(() => one.get(job.id)).toThrow("Unknown");
  });

  it("evicts only oldest finished entries and isolates throwing event subscribers", async () => {
    const instance = createJobManager(() => {
      throw new Error("subscriber failure");
    });
    managers.push(instance);
    const running = await instance.start({ command: "sleep 20", cwd });
    // Establish the oldest finished identity before batching the remaining jobs.
    // This tests retention, not 33 serial helper startups within the runner guard.
    const oldest = await instance.start({ command: "printf 'hit\\n'", cwd, watch: { patterns: ["hit"] } });
    await finished(instance, oldest.id);
    const completed: string[] = [oldest.id];
    const batchSize = LIMITS.running - 1; // The long-running job still owns one slot.
    for (let index = 1; index < 33; index += batchSize) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(batchSize, 33 - index) }, () =>
          instance.start({ command: "printf 'hit\\n'", cwd, watch: { patterns: ["hit"] } }),
        ),
      );
      await Promise.all(batch.map((job) => finished(instance, job.id)));
      completed.push(...batch.map((job) => job.id));
    }
    expect(instance.list()).toHaveLength(32);
    expect(instance.get(running.id).status).toBe("running");
    expect(() => instance.get(completed[0])).toThrow("Unknown");
    expect(instance.clear()).toBe(31);
    expect(instance.list()).toHaveLength(1);
  });

  it("publishes isolated local changes for start/output/watch/confirmed stop/clear without model events", async () => {
    const events: JobEvent[] = [];
    const instance = manager(events);
    const states: Array<{ count: number; status?: string; ended?: number; output?: string }> = [];
    const throwing = instance.subscribe(() => {
      throw new Error("UI failure");
    });
    const unsubscribe = instance.subscribe(() => {
      const current = instance.list()[0];
      states.push({
        count: instance.list().length,
        status: current?.status,
        ended: current?.endedAt,
        output: current ? instance.logs(current.id).text : undefined,
      });
    });
    const job = await instance.start({ command: "sleep .1; printf 'live-output\\n'; sleep 20", cwd, attention: "off" });
    expect(states.some((state) => state.status === "running")).toBe(true);
    const beforeWatch = states.length;
    instance.watch(job.id, { patterns: ["never"] });
    expect(states.length).toBeGreaterThan(beforeWatch);
    await until(() => states.some((state) => state.output?.includes("live-output")));
    const stopped = await instance.stop(job.id);
    expect(stopped.endedAt).toBeDefined();
    expect(states.some((state) => state.status === "stopped" && state.ended !== undefined)).toBe(true);
    instance.clear(job.id);
    expect(states.at(-1)?.count).toBe(0);
    expect(events).toEqual([]);
    unsubscribe();
    unsubscribe();
    throwing();
    const count = states.length;
    await instance.shutdown();
    expect(states.length).toBe(count);
  });

  it("notifies shutdown once and releases subscribers before late child output; late subscriptions are inert", async () => {
    const instance = manager();
    await instance.start({ command: "sleep 20", cwd, attention: "off" });
    const listener = vi.fn();
    instance.subscribe(listener);
    const shutdown = instance.shutdown();
    expect(listener).toHaveBeenCalledOnce();
    const later = vi.fn();
    const unsubscribe = instance.subscribe(later);
    await shutdown;
    await instance.shutdown();
    unsubscribe();
    unsubscribe();
    expect(listener).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  });

  it("explicitly rejects unsupported Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(() => createJobManager(() => {})).toThrow("win32");
  });
});

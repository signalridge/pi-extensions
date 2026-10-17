import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { APPROVAL_QUERY_CHANNEL, validateQuery } from "@signalridge/pi-approval-core";
import { afterEach, expect, it, vi } from "vitest";
import { createJobManager } from "../src/manager.js";
import { Ownership } from "../src/ownership.js";
import { registerTools } from "../src/tools.js";

const delayed = vi.hoisted(() => ({
  stat: undefined as undefined | (() => Promise<void>),
  handshake: false,
  children: [] as ChildProcess[],
  waiting: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return {
    ...module,
    stat: async (path: string) => {
      await delayed.stat?.();
      return module.stat(path);
    },
  };
});
vi.mock("node:child_process", async (original) => {
  const module = await original<typeof import("node:child_process")>();
  return {
    ...module,
    spawn: (...args: Parameters<typeof module.spawn>) => {
      const child = module.spawn(...args);
      delayed.children.push(child);
      vi.spyOn(child, "send");
      child.on("message", (value) => {
        if (value && typeof value === "object" && "kind" in value && value.kind === "test-waiting")
          delayed.waiting = true;
      });
      return child;
    },
  };
});
vi.mock("../src/supervisor.js", async (original) => {
  const module = await original<typeof import("../src/supervisor.js")>();
  return {
    get SUPERVISOR_SOURCE() {
      return delayed.handshake
        ? module.SUPERVISOR_SOURCE.replace(
            'send({ kind: "ready" });',
            'process.on("message", m => { if (m.kind === "test-ready") send({ kind: "ready" }); }); send({ kind: "test-waiting" });',
          )
        : module.SUPERVISOR_SOURCE;
    },
  };
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  delayed.stat = undefined;
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  delayed.handshake = false;
  delayed.waiting = false;
  delayed.children.length = 0;
});
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(peer = true) {
  const cwd = await mkdtemp(join(tmpdir(), "approval-launch-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const listeners = new Set<(value: unknown) => void>();
  const events = {
    on: (channel: string, handler: (value: unknown) => void) => {
      if (channel === APPROVAL_QUERY_CHANNEL) listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emit: (channel: string, value: unknown) => {
      if (channel === APPROVAL_QUERY_CHANNEL) for (const listener of listeners) listener(value);
    },
  };
  const service = { version: 1, id: "captured", request: vi.fn(async () => {}) };
  let current: { version: number; id: string; request: () => Promise<void> } = service;
  const respond = (value: unknown) => validateQuery(value).respond(current);
  if (peer) listeners.add(respond);
  let branch = ["root"];
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => "session", getBranch: () => branch.map((id) => ({ id })) },
  } as unknown as ExtensionToolContext;
  const manager = createJobManager(() => {});
  cleanup.push(() => manager.shutdown());
  const owner = new Ownership(ctx, () => {});
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    events,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on() {},
  } as unknown as ExtensionAPI;
  registerTools(pi, {
    manager: () =>
      owner.guard(manager, () => {
        if (!owner.live(ctx)) throw new Error("Stale owner");
      }),
    pending: () => ({ pendingNotifications: 0, deliveryPaused: false }),
    cancel() {},
  });
  const marker = join(cwd, "executed");
  const tool = tools.get("bash_background");
  if (!tool) throw new Error("Missing tool");
  return {
    manager,
    marker,
    service,
    launch: () =>
      tool.execute("launch", { command: `printf escaped > '${marker}'`, notify: "off" }, undefined, undefined, ctx),
    change: (kind: string) => {
      if (kind === "owner") branch = ["other"];
      else if (kind === "remove") listeners.delete(respond);
      else if (kind === "replace") current = { ...service, request: async () => {} };
      else listeners.add((value) => validateQuery(value).respond(service));
    },
  };
}
it.each(
  ["stat", "handshake"].flatMap((boundary) =>
    ["owner", "remove", "replace", "duplicate"].map((change) => ({ boundary, change })),
  ),
)("checks captured service and owner after delayed $boundary: $change", async ({ boundary, change }) => {
  const f = await fixture();
  const entered = gate();
  const resume = gate();
  delayed.stat =
    boundary === "stat"
      ? async () => {
          entered.resolve();
          await resume.promise;
        }
      : undefined;
  delayed.handshake = boundary === "handshake";
  const result = f.launch().then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    if (boundary === "stat") await entered.promise;
    else await vi.waitFor(() => expect(delayed.waiting).toBe(true));
    expect(f.service.request).toHaveBeenCalledOnce();
    f.change(change);
  } finally {
    resume.resolve();
    if (boundary === "handshake" && delayed.children.at(-1)?.connected)
      delayed.children.at(-1)?.send({ kind: "test-ready" });
  }
  expect(await result).toBeInstanceOf(Error);
  await f.manager.shutdown();
  expect(existsSync(f.marker)).toBe(false);
  for (const child of delayed.children) {
    expect(
      vi
        .mocked(child.send)
        .mock.calls.some(
          ([message]) => message && typeof message === "object" && "kind" in message && message.kind === "run",
        ),
    ).toBe(false);
    const pid = child.pid;
    if (pid) expect(() => process.kill(-pid, 0)).toThrow();
  }
});
it("absent-at-entry launch remains ungated when a service arrives during stat", async () => {
  const f = await fixture(false);
  const entered = gate();
  const resume = gate();
  delayed.stat = async () => {
    entered.resolve();
    await resume.promise;
  };
  const result = f.launch();
  await entered.promise;
  f.change("duplicate");
  resume.resolve();
  await result;
  await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true));
  expect(f.service.request).not.toHaveBeenCalled();
});

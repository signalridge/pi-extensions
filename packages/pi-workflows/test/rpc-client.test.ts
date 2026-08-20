import { describe, expect, it } from "vitest";
import { checkManagedSpawnProtocol, createManagedSpawnClient, queryChildSessionContext } from "../src/rpc-client.js";

class Bus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.listeners.get(event) ?? new Set<(data: unknown) => void>();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, data: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(data);
  }
}

describe("pi-subagents protocol capability check", () => {
  it("detects a factory-time child context without starting the ping", async () => {
    const bus = new Bus();
    bus.on("subagents:rpc:context", (raw) => {
      const request = raw as { requestId: string };
      bus.emit(`subagents:rpc:context:reply:${request.requestId}`, {
        success: true,
        data: { child: true, capability: "childContext" },
      });
    });
    await expect(queryChildSessionContext(bus, 20)).resolves.toBe(true);
  });

  it("treats a missing context responder as an absent companion extension", async () => {
    await expect(queryChildSessionContext(new Bus(), 1)).resolves.toBeUndefined();
  });

  it("accepts protocol v3 managed-spawn capabilities", async () => {
    const bus = new Bus();
    bus.on("subagents:rpc:ping", (raw) => {
      const request = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: {
          version: 3,
          capabilities: {
            managedSpawn: true,
            lifecycleOwner: true,
            ownedStop: true,
            childContext: true,
            ownedQuiescence: true,
            workflowTiers: true,
            managedPolicy: true,
          },
        },
      });
    });
    await expect(checkManagedSpawnProtocol(bus)).resolves.toBeUndefined();
  });

  it("accepts readiness when pi-subagents registers after the initial ping", async () => {
    const bus = new Bus();
    const check = checkManagedSpawnProtocol(bus);
    setTimeout(() => {
      bus.emit("subagents:ready", {
        version: 3,
        capabilities: {
          managedSpawn: true,
          lifecycleOwner: true,
          ownedStop: true,
          ownedQuiescence: true,
          workflowTiers: true,
          managedPolicy: true,
        },
      });
    }, 10);
    await expect(check).resolves.toBeUndefined();
  });

  it("rejects a v3 peer that lacks owner-scoped stop", async () => {
    const bus = new Bus();
    bus.on("subagents:rpc:ping", (raw) => {
      const request = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: 3, capabilities: { managedSpawn: true, lifecycleOwner: true } },
      });
    });
    await expect(checkManagedSpawnProtocol(bus)).rejects.toThrow(/owned stop/);
  });

  it("rejects an old or incomplete subagents protocol", async () => {
    const bus = new Bus();
    bus.on("subagents:rpc:ping", (raw) => {
      const request = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: 2, capabilities: {} },
      });
    });
    await expect(checkManagedSpawnProtocol(bus)).rejects.toThrow(/protocol v3/);
  });

  it("cancels the RPC wait with the session signal without exposing a foreground signal", async () => {
    const bus = new Bus();
    let dispatched = false;
    bus.on("subagents:rpc:spawn-managed", () => {
      dispatched = true;
    });
    const protocol = new AbortController();
    const session = new AbortController();
    const client = createManagedSpawnClient(bus, protocol.signal, session.signal);

    const pending = client.spawn({} as never, "run-1", "a", "attempt-1");
    expect(dispatched).toBe(true);
    session.abort(new Error("session ended"));
    await expect(pending).rejects.toThrow("subagents:rpc:spawn-managed request aborted");
    protocol.abort();
  });
  it("returns a structured terminal managed-spawn response", async () => {
    const bus = new Bus();
    bus.on("subagents:rpc:spawn-managed", (raw) => {
      const request = raw as { requestId: string };
      bus.emit(`subagents:rpc:spawn-managed:reply:${request.requestId}`, {
        success: true,
        data: {
          id: "agent-terminal",
          state: "completed",
          terminal: {
            status: "completed",
            result: "already done",
            compactionCount: 1,
            completedAt: 42,
          },
        },
      });
    });
    const client = createManagedSpawnClient(bus);
    await expect(client.spawn({} as never, "run-1", "a", {} as never)).resolves.toEqual({
      id: "agent-terminal",
      state: "completed",
      terminal: {
        status: "completed",
        result: "already done",
        compactionCount: 1,
        completedAt: 42,
      },
    });
  });
});

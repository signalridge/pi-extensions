import {
  type ManagedRoutingPolicy,
  PROTOCOL_CAPABILITIES,
  PROTOCOL_VERSION,
  routingPolicyFingerprint,
} from "@signalridge/pi-subagents-protocol";
import { describe, expect, it } from "vitest";
import { checkManagedSpawnProtocol, createManagedSpawnClient, queryChildSessionContext } from "../src/rpc-client.js";

const ROUTING_POLICY: ManagedRoutingPolicy = {
  defaultTier: "medium",
  profiles: {
    low: { model: "inherit", thinking: "low" },
    medium: { model: "inherit", thinking: "medium" },
  },
  blockedProfiles: [],
  blockedDefaultTier: false,
};
const ROUTING_POLICY_SNAPSHOT = {
  policy: ROUTING_POLICY,
  fingerprint: routingPolicyFingerprint(ROUTING_POLICY),
};
const CAPABILITIES = { ...PROTOCOL_CAPABILITIES };
const EXPECTED_CHECK = {
  routingPolicy: ROUTING_POLICY,
  routingPolicyFingerprint: ROUTING_POLICY_SNAPSHOT.fingerprint,
};

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

  it("accepts a complete peer and returns the catalogue, not just its fingerprint", async () => {
    const bus = new Bus();
    bus.on("subagents:rpc:ping", (raw) => {
      const request = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: PROTOCOL_VERSION, capabilities: CAPABILITIES, routingPolicy: ROUTING_POLICY_SNAPSHOT },
      });
    });
    // The policy itself is what a resume needs: each cached call keys on the
    // profile for its own tier, which a fingerprint alone cannot supply.
    await expect(checkManagedSpawnProtocol(bus)).resolves.toEqual(EXPECTED_CHECK);
  });

  it("asks for the host pool size and carries it through when the peer answers", async () => {
    const bus = new Bus();
    let requested: unknown;
    bus.on("subagents:rpc:ping", (raw) => {
      const request = raw as { requestId: string; include?: unknown };
      requested = request.include;
      bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: {
          version: PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          routingPolicy: ROUTING_POLICY_SNAPSHOT,
          maxConcurrent: 40,
        },
      });
    });
    await expect(checkManagedSpawnProtocol(bus)).resolves.toEqual({ ...EXPECTED_CHECK, maxConcurrent: 40 });
    // Requested by name, because the reply envelope is strictly parsed: a peer
    // may not volunteer a field to a caller that predates it.
    expect(requested).toEqual(["maxConcurrent"]);
  });

  it("accepts a peer that publishes no pool size", async () => {
    const bus = new Bus();
    bus.on("subagents:rpc:ping", (raw) => {
      const request = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: PROTOCOL_VERSION, capabilities: CAPABILITIES, routingPolicy: ROUTING_POLICY_SNAPSHOT },
      });
    });
    await expect(checkManagedSpawnProtocol(bus)).resolves.toEqual(EXPECTED_CHECK);
  });

  it("rejects a peer missing any single capability", async () => {
    for (const key of Object.keys(CAPABILITIES)) {
      const { [key]: _dropped, ...partial } = CAPABILITIES as Record<string, boolean>;
      const bus = new Bus();
      bus.on("subagents:rpc:ping", (raw) => {
        const request = raw as { requestId: string };
        bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
          success: true,
          data: { version: PROTOCOL_VERSION, capabilities: partial, routingPolicy: ROUTING_POLICY_SNAPSHOT },
        });
      });
      await expect(checkManagedSpawnProtocol(bus)).rejects.toThrow(new RegExp(`protocol v${PROTOCOL_VERSION}`));
    }
  });

  it("rejects an otherwise capable peer that omits routing-policy metadata", async () => {
    const bus = new Bus();
    bus.on("subagents:rpc:ping", (raw) => {
      const request = raw as { requestId: string };
      bus.emit(`subagents:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: PROTOCOL_VERSION, capabilities: CAPABILITIES },
      });
    });
    await expect(checkManagedSpawnProtocol(bus)).rejects.toThrow(new RegExp(`protocol v${PROTOCOL_VERSION}`));
  });

  it("accepts readiness when pi-subagents registers after the initial ping", async () => {
    const bus = new Bus();
    const check = checkManagedSpawnProtocol(bus);
    setTimeout(() => {
      bus.emit("subagents:ready", {
        version: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        routingPolicy: ROUTING_POLICY_SNAPSHOT,
      });
    }, 10);
    await expect(check).resolves.toEqual(EXPECTED_CHECK);
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
    await expect(checkManagedSpawnProtocol(bus)).rejects.toThrow(new RegExp(`protocol v${PROTOCOL_VERSION}`));
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
    await expect(client.spawn({} as never, "run-1", "a", undefined)).resolves.toEqual({
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

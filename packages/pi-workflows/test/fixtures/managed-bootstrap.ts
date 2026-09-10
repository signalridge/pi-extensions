import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WorkflowEngine } from "../../src/engine.js";
import type { JournalEvent, WorkflowOwner } from "../../src/journal.js";
import { createManagedSpawnClient, type WorkflowEventBus } from "../../src/rpc-client.js";

const mode = process.argv[2];
const emitter = new EventEmitter();
// Match Pi 0.85.1's synchronous emit + async safeHandler. No process-level
// rejection handler: --unhandled-rejections=strict must terminate a broken run.
const bus: WorkflowEventBus = {
  emit(channel, data) {
    emitter.emit(channel, data);
  },
  on(channel, handler) {
    const safeHandler = async (data: unknown) => {
      try {
        await handler(data);
      } catch (error) {
        console.error(`Event handler error (${channel}):`, error);
      }
    };
    emitter.on(channel, safeHandler);
    return () => emitter.off(channel, safeHandler);
  },
};
const client = createManagedSpawnClient(bus);
client.checkProtocol = async () => ({
  routingPolicy: {
    defaultTier: "medium",
    profiles: { medium: { model: "inherit", thinking: "medium" } },
    blockedProfiles: [],
    blockedDefaultTier: false,
  },
  routingPolicyFingerprint: "test-policy",
});
interface Request {
  requestId: string;
  spawnKey: string;
  owner: WorkflowOwner;
  agentId?: string;
  owners?: WorkflowOwner[];
}
const allocations = new Map<string, { id: string; owner: WorkflowOwner; cleaned: boolean }>();
const entries: JournalEvent[] = [];
const invocation = new AbortController();
let spawns = 0;
let reconciliations = 0;
let lateReplies = 0;
let cleanupConfirmed = false;
let pendingSpawn!: () => void;
const spawnStarted = new Promise<void>((resolve) => {
  pendingSpawn = resolve;
});
const reply = (channel: string, request: Request, data?: unknown) =>
  bus.emit(`${channel}:reply:${request.requestId}`, { success: true, data });

bus.on("subagents:rpc:spawn-managed", (raw) => {
  const request = raw as Request;
  const id = `child-${++spawns}`;
  const allocation = { id, owner: request.owner, cleaned: false };
  allocations.set(request.spawnKey, allocation);
  pendingSpawn();
  if (mode === "slow") {
    // Model synchronous host Git/worktree setup AFTER RPC listener registration.
    const until = performance.now() + 1_300;
    while (performance.now() < until) {
      /* synchronous host work */
    }
  }
  if (mode === "sync-abort") invocation.abort();
  if (mode === "fatal" || mode === "abort" || mode === "sync-abort") {
    setTimeout(() => {
      lateReplies++;
      reply("subagents:rpc:spawn-managed", request, { id, state: "running" });
    }, 40);
    return;
  }
  allocation.cleaned = true;
  reply("subagents:rpc:spawn-managed", request, {
    id,
    terminal: { status: "completed", result: id, compactionCount: 0, completedAt: Date.now() },
  });
});

bus.on("subagents:rpc:reconcile-managed", (raw) => {
  const request = raw as Request;
  const allocation = allocations.get(request.spawnKey);
  assert.ok(allocation);
  assert.deepEqual(request.owner, allocation.owner);
  reconciliations++;
  reply("subagents:rpc:reconcile-managed", request, { id: allocation.id, state: "running" });
});
bus.on("subagents:rpc:stop-owned", (raw) => {
  const request = raw as Request;
  const allocation = [...allocations.values()].find((item) => item.id === request.agentId);
  assert.ok(allocation);
  assert.deepEqual(request.owner, allocation.owner);
  reply("subagents:rpc:stop-owned", request);
});
bus.on("subagents:rpc:quiesce-owned", (raw) => {
  const request = raw as Request;
  for (const allocation of allocations.values()) {
    if (allocation.cleaned) continue;
    assert.ok(request.owners?.some((owner) => JSON.stringify(owner) === JSON.stringify(allocation.owner)));
  }
  setTimeout(() => {
    for (const allocation of allocations.values()) allocation.cleaned = true;
    cleanupConfirmed = true;
    reply("subagents:rpc:quiesce-owned", request, { settled: true, pending: [] });
  }, 80);
});
const engine = new WorkflowEngine(bus, client, { append: (entry) => entries.push(entry) });
const envelope = 'export const meta = { name: "bootstrap-regression", description: "test" };';
const scripts: Record<string, string> = {
  slow: `return await parallel(["one", "two"].map(u => () => agent(u, { agentType: "Implement", strength: "medium", isolation: "worktree" })));`,
  busy: `const pending = agent("never-start"); while (true) {} return await pending;`,
  fatal: `const pending = agent("pending"); await agent("trigger"); throw new Error("script failed");`,
  abort: `return await agent("pending");`,
  "sync-abort": `return await agent("pending");`,
};
// For fatal mode the second call returns immediately, while the first is still
// awaiting its spawn ack. This exercises cancellation of an actually live RPC.
if (mode === "fatal") {
  bus.on("subagents:rpc:spawn-managed", (raw) => {
    const request = raw as Request;
    if (!request.spawnKey.includes("/call-1/")) return;
    const allocation = allocations.get(request.spawnKey);
    assert.ok(allocation);
    allocation.cleaned = true;
    reply("subagents:rpc:spawn-managed", request, {
      id: "child-2",
      terminal: { status: "completed", result: "trigger", compactionCount: 0, completedAt: Date.now() },
    });
  });
}
assert.ok(mode && scripts[mode], "expected a regression mode");
const pending = engine.start(`${envelope}\n${scripts[mode]}`, { signal: invocation.signal, background: false });
// Observe immediately, including synchronous bootstrap failures.
const settled = pending.then(
  (result) => ({ result }),
  (error: unknown) => ({ error }),
);
if (mode === "abort") {
  await spawnStarted;
  invocation.abort();
}
const outcome = await settled;
const cleanedAtSettlement = cleanupConfirmed;
console.log(JSON.stringify({ mode, outcome, spawns, reconciliations, cleanupConfirmed, entries }));
await delay(120); // Let an unobserved RPC rejection surface before assertions.
if (mode === "slow") {
  assert.ok("result" in outcome);
  assert.equal(outcome.result.status, "completed");
  assert.equal(spawns, 2);
} else if (mode === "busy") {
  assert.match(JSON.stringify(outcome) + JSON.stringify(entries), /Script execution timed out after 1000ms/);
  assert.equal(spawns, 0, "timed-out script must not allocate a deferred child");
} else {
  assert.ok(reconciliations > 0);
  assert.equal(cleanedAtSettlement, true, "run must await exact-owner cleanup");
}
assert.ok([...allocations.values()].every((item) => item.cleaned));
engine.dispose();
await delay(120); // Late replies and Node's unhandled rejection turn must drain.
assert.equal(emitter.eventNames().filter((name) => String(name).includes(":reply:")).length, 0);
if (mode === "fatal" || mode === "abort" || mode === "sync-abort") assert.ok(lateReplies > 0);
if (mode === "fatal") assert.match(JSON.stringify(outcome), /script failed/);
console.log(`PASS ${mode}`);

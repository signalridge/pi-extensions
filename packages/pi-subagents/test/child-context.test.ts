import { describe, expect, it, vi } from "vitest";
import { inChildSessionContext, runInChildSessionContext } from "../src/child-context.js";
import subagentsExtension from "../src/index.js";

describe("child session async context", () => {
  it("is scoped to the child async branch", async () => {
    expect(inChildSessionContext()).toBe(false);
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
      await Promise.resolve();
      expect(inChildSessionContext()).toBe(true);
    });
    expect(inChildSessionContext()).toBe(false);
  });

  it("registers only the safe context reply in a child resource load", async () => {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const pi = {
      events: {
        on(event: string, handler: (data: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(data: unknown) => void>();
          handlers.add(handler);
          listeners.set(event, handlers);
          return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
          for (const handler of listeners.get(event) ?? []) handler(data);
        },
      },
      on: vi.fn(),
    };

    await runInChildSessionContext(async () => {
      subagentsExtension(pi as never);
    });
    const reply = vi.fn();
    pi.events.on("subagents:rpc:context:reply:child-test", reply);
    pi.events.emit("subagents:rpc:context", { requestId: "child-test" });
    expect(reply).toHaveBeenCalledWith({
      success: true,
      data: { child: true, capability: "childContext" },
    });
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });
});

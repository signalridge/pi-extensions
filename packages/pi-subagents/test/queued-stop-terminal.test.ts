import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

describe("queued managed stop terminal callback", () => {
  let manager: AgentManager | undefined;
  afterEach(async () => { await manager?.dispose(); });

  it("settles a queued record once when stopped", () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);
    const complete = vi.fn();
    manager = new AgentManager(complete, 1);
    manager.spawn({} as never, { cwd: "/tmp" } as never, "Explore", "block", {
      description: "block",
      isBackground: true,
    });
    const queued = manager.spawn({} as never, { cwd: "/tmp" } as never, "Explore", "queued", {
      description: "queued",
      isBackground: true,
    });

    expect(manager.getRecord(queued)?.status).toBe("queued");
    expect(manager.abort(queued)).toBe(true);
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(manager.abort(queued)).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

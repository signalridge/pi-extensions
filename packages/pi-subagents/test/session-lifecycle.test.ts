import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { shutdownAndDisposeSession } from "../src/session-lifecycle.js";

describe("child session lifecycle", () => {
  it("publishes the in-flight teardown before invoking shutdown handlers", async () => {
    let reentrant: Promise<void> | undefined;
    const session = {
      extensionRunner: {
        emit: vi.fn(() => {
          reentrant = shutdownAndDisposeSession(session as unknown as AgentSession);
          return Promise.resolve();
        }),
      },
      dispose: vi.fn(),
    } as unknown as AgentSession;

    const teardown = shutdownAndDisposeSession(session);
    await teardown;

    expect(reentrant).toBe(teardown);
    expect(session.extensionRunner?.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});

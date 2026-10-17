import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JobManager } from "./contracts.js";

/** Observe the live branch, not a delayed lifecycle callback. Retirement is final. */
export class Ownership {
  private readonly sessionManager: ExtensionContext["sessionManager"];
  private readonly sessionId: string;
  private branchIds: string[];
  private retired = false;

  constructor(
    ctx: ExtensionContext,
    private readonly retire: () => void,
  ) {
    this.sessionManager = ctx.sessionManager;
    this.sessionId = this.sessionManager.getSessionId();
    this.branchIds = this.sessionManager.getBranch().map((entry) => entry.id);
  }

  live(ctx: ExtensionContext): boolean {
    if (this.retired) return false;
    try {
      const branch = this.sessionManager.getBranch().map((entry) => entry.id);
      if (
        ctx.sessionManager === this.sessionManager &&
        this.sessionManager.getSessionId() === this.sessionId &&
        this.branchIds.every((id, index) => branch[index] === id)
      ) {
        // Ordinary appends remain owned; remember them before any later await.
        this.branchIds = branch;
        return true;
      }
    } catch {
      // A disposed host context is also a retired owner.
    }
    this.retired = true;
    this.retire();
    return false;
  }

  /** Bind all accesses and post-await results to the owner that began the call. */
  guard(manager: JobManager, check: () => void): JobManager {
    return {
      subscribe: (listener) => {
        check();
        return manager.subscribe(() => {
          try {
            check();
          } catch {
            return;
          }
          listener();
        });
      },
      start: async (options, signal, launchGuard) => {
        check();
        const result = await manager.start(options, signal, () => {
          check();
          launchGuard?.();
        });
        check();
        return result;
      },
      stop: async (id) => {
        check();
        const result = await manager.stop(id);
        check();
        return result;
      },
      watch: (id, options) => {
        check();
        return manager.watch(id, options);
      },
      list: () => {
        check();
        return manager.list();
      },
      get: (id) => {
        check();
        return manager.get(id);
      },
      logs: (id, tail, stream) => {
        check();
        return manager.logs(id, tail, stream);
      },
      clear: (id) => {
        check();
        return manager.clear(id);
      },
      shutdown: () => {
        check();
        return manager.shutdown();
      },
    };
  }
}

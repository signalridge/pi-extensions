import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  APPROVAL_LIFECYCLE_CHANNEL,
  type ApprovalEvents,
  type ApprovalLifecycle,
  type ApprovalOperation,
  type ApprovalOutcome,
  type ApprovalRequestOptions,
  type ApprovalService,
  assertCurrent,
  validateLifecycle,
  validateOperation,
} from "@signalridge/pi-approval-core";

export const MAX_PENDING = 32;
export const MAX_RETAINED = 128;
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
interface Pending {
  readonly id: string;
  readonly operation: ApprovalOperation;
  readonly controller: AbortController;
  readonly check: () => void;
  readonly finish: (outcome: ApprovalOutcome) => void;
  reviewing: boolean;
}
function fingerprint(ctx: ExtensionContext): readonly string[] {
  return ctx.sessionManager.getBranch().map((entry) => JSON.stringify(entry));
}
function extendsBranch(before: readonly string[], after: readonly string[]): boolean {
  return before.length <= after.length && before.every((entry, index) => entry === after[index]);
}
export class ApprovalBroker {
  readonly service: ApprovalService;
  readonly pending = new Map<string, Pending>();
  readonly retained: ApprovalLifecycle[] = [];
  private retired = false;
  private reviewing = false;
  private readonly boundManager: ExtensionContext["sessionManager"];
  private readonly boundSession: string;
  private branch: readonly string[];

  constructor(
    private readonly events: ApprovalEvents,
    private readonly currentContext: () => ExtensionContext,
    private readonly isBound: () => boolean,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    const initial = currentContext();
    this.boundManager = initial.sessionManager;
    this.branch = fingerprint(initial);
    this.boundSession = JSON.stringify([
      initial.sessionManager.getSessionId(),
      initial.sessionManager.getSessionFile(),
    ]);
    this.service = Object.freeze({
      version: 1,
      id: randomUUID(),
      request: (operation: ApprovalOperation, options: ApprovalRequestOptions) => this.request(operation, options),
    });
  }
  private emit(
    id: string,
    operation: ApprovalOperation,
    phase: ApprovalLifecycle["phase"],
    outcome?: ApprovalOutcome,
  ): void {
    const event = validateLifecycle({
      version: 1,
      serviceId: this.service.id,
      requestId: id,
      source: operation.source,
      toolCallId: operation.toolCallId,
      phase,
      ...(outcome ? { outcome } : {}),
    });
    this.events.emit(APPROVAL_LIFECYCLE_CHANNEL, event);
    if (phase === "resolved") {
      this.retained.push(event);
      if (this.retained.length > MAX_RETAINED) this.retained.shift();
    }
  }
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const item of this.pending.values()) item.finish("retired");
  }
  /** Discovery must observe retirement even after the last request has resolved. */
  get isLive(): boolean {
    try {
      this.assertLive();
      return true;
    } catch {
      return false;
    }
  }
  private assertLive(): ExtensionContext {
    if (this.retired) throw new Error("Approval service retired");
    try {
      if (!this.isBound()) throw new Error("Approval canonical tool bindings were replaced");
      const ctx = this.currentContext();
      if (
        ctx.sessionManager !== this.boundManager ||
        JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile()]) !== this.boundSession
      )
        throw new Error("Approval native session changed");
      const branch = fingerprint(ctx);
      if (!extendsBranch(this.branch, branch)) throw new Error("Approval native branch diverged");
      this.branch = branch;
      if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) throw new Error("No human approval UI available");
      return ctx;
    } catch (error) {
      this.retire();
      throw error;
    }
  }
  request(value: ApprovalOperation, options: ApprovalRequestOptions): Promise<void> {
    try {
      const operation = validateOperation(value);
      if (
        !options ||
        typeof options.isCurrent !== "function" ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal))
      )
        throw new Error("Invalid approval owner options");
      assertCurrent(options);
      const ctx = this.assertLive();
      const manager = ctx.sessionManager;
      const captured = fingerprint(ctx);
      if (this.pending.size >= MAX_PENDING) throw new Error("Too many pending approvals");
      const id = randomUUID();
      const controller = new AbortController();
      const check = () => {
        assertCurrent(options);
        const now = this.assertLive();
        if (now.sessionManager !== manager || !extendsBranch(captured, fingerprint(now))) {
          this.retire();
          throw new Error("Approval native session or branch changed");
        }
      };
      return new Promise<void>((resolve, reject) => {
        let finished = false;
        const onAbort = () => finish("cancelled");
        const timer = setTimeout(() => finish("expired"), this.timeoutMs);
        const monitor = setInterval(() => {
          try {
            check();
          } catch {
            finish("retired");
          }
        }, 100);
        const finish = (outcome: ApprovalOutcome) => {
          if (finished) return;
          if (outcome === "approved") {
            try {
              check();
            } catch {
              outcome = "retired";
            }
          }
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearInterval(monitor);
          options.signal?.removeEventListener("abort", onAbort);
          this.pending.delete(id);
          controller.abort();
          try {
            this.emit(id, operation, "resolved", outcome);
            this.status();
          } catch {
            outcome = "error";
          }
          if (outcome === "approved") resolve();
          else reject(new Error(`Approval ${outcome}`));
        };
        this.pending.set(id, { id, operation, controller, check, finish, reviewing: false });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          check();
          this.emit(id, operation, "waiting");
          this.status();
        } catch {
          finish("error");
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private status(): void {
    const ctx = this.currentContext();
    if (ctx.hasUI)
      ctx.ui.setStatus(
        `approvals:${this.service.id}`,
        this.pending.size ? `Approvals: ${this.pending.size} (/approvals)` : undefined,
      );
  }
  /** Human command only. Never called from a tool or event-bus response. */
  async review(
    id: string,
    ctx: ExtensionContext,
    decide: (operation: ApprovalOperation, signal: AbortSignal) => Promise<boolean>,
    deny = false,
  ): Promise<void> {
    const item = this.pending.get(id);
    if (!item) throw new Error("Unknown pending approval");
    if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) throw new Error("No human approval UI available");
    item.check();
    // Denial opens no UI and may cancel this or another request while a review is open.
    if (deny) {
      try {
        this.emit(id, item.operation, "respond", "denied");
        item.finish("denied");
      } catch (error) {
        item.finish("error");
        throw error;
      }
      return;
    }
    if (this.reviewing || item.reviewing) throw new Error("An approval review is already open");
    this.reviewing = item.reviewing = true;
    try {
      const confirmed = await decide(item.operation, item.controller.signal);
      if (!this.pending.has(id)) return;
      item.check();
      this.emit(id, item.operation, "respond", confirmed === true ? "approved" : "denied");
      item.finish(confirmed === true ? "approved" : "denied");
    } catch (error) {
      item.finish("error");
      throw error;
    } finally {
      this.reviewing = item.reviewing = false;
    }
  }
}

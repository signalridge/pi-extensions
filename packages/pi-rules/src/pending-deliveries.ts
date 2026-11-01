import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DeliveryChannel } from "./ledger.js";
import type { Rule } from "./rule.js";

type Context = Pick<ExtensionContext, "sessionManager" | "signal">;
interface Claim {
  manager: Context["sessionManager"];
  session: string;
  branch: string[];
  generation: number;
  via: DeliveryChannel;
  rules: readonly Rule[];
  content: string;
  signal?: AbortSignal;
  cancel(): void;
}

/** Queued steering is not durable delivery. Only its own native admission earns a receipt. */
export class PendingDeliveries {
  private generation = 0;
  private claims = new Map<object, Claim>();

  clear(): void {
    this.generation++;
    for (const claim of [...this.claims.values()]) claim.cancel();
  }

  has(name: string, ctx: Context): boolean {
    for (const claim of [...this.claims.values()]) {
      if (!this.owns(claim, ctx)) claim.cancel();
      else if (claim.rules.some((rule) => rule.name === name)) return true;
    }
    return false;
  }

  queue(ctx: Context, via: DeliveryChannel, rules: readonly Rule[], content: string) {
    // Pi preserves this details object by identity through its native queue.
    // Serialized/copied details cannot grant an admission in this runtime.
    const details = Object.freeze({ rules: rules.map((rule) => rule.name) });
    const signal = ctx.signal;
    const claim: Claim = {
      manager: ctx.sessionManager,
      session: ctx.sessionManager.getSessionId(),
      branch: ctx.sessionManager.getBranch().map((entry) => entry.id),
      generation: this.generation,
      via,
      rules,
      content,
      signal,
      cancel: () => {
        this.claims.delete(details);
        signal?.removeEventListener("abort", claim.cancel);
      },
    };
    this.claims.set(details, claim);
    signal?.addEventListener("abort", claim.cancel, { once: true });
    if (signal?.aborted) claim.cancel();
    return { details, cancel: claim.cancel };
  }

  admit(
    message: { details?: unknown; content: unknown; display: boolean },
    ctx: Context,
  ): { via: DeliveryChannel; rules: readonly Rule[] } | undefined {
    const details = message.details;
    if (!details || typeof details !== "object") return;
    const claim = this.claims.get(details);
    if (!claim) return;
    const valid = this.owns(claim, ctx) && message.content === claim.content && message.display === false;
    claim.cancel();
    return valid ? { via: claim.via, rules: claim.rules } : undefined;
  }

  private owns(claim: Claim, ctx: Context): boolean {
    if (
      claim.generation !== this.generation ||
      claim.signal?.aborted ||
      claim.manager !== ctx.sessionManager ||
      claim.session !== ctx.sessionManager.getSessionId()
    )
      return false;
    const branch = ctx.sessionManager.getBranch();
    return claim.branch.every((id, index) => branch[index]?.id === id);
  }
}

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Durability, fingerprint, isState, Persistence, VOLATILE } from "./persistence.js";
import { copy, empty, type Snapshot, STATE_TYPE, transition, validateSnapshot } from "./state.js";

function authority(branch: readonly SessionEntry[]): string {
  return fingerprint([...branch].reverse().find(isState) ?? null);
}
export function recover(branch: readonly SessionEntry[]): { snapshot: Snapshot; invalid: number; record?: string } {
  let invalid = 0;
  for (const entry of [...branch].reverse()) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
    try {
      return { snapshot: validateSnapshot(entry.data), invalid, record: fingerprint(entry) };
    } catch {
      invalid++;
    }
  }
  return { snapshot: empty(), invalid };
}
export interface Ownership {
  manager: ExtensionContext["sessionManager"];
  session: string;
  file: string | undefined;
  prefix: string[];
  authority: string;
  generation: number;
}

/** Synchronous commits, with separate native ownership and positive on-disk verification.
 * The SDK may change its native branch before a failed write. We never roll it back.
 */
export class TodoStore {
  private snapshot = empty();
  private snapshotRecord?: string;
  private owner?: Ownership;
  private generation = 0;
  private committing = false;
  private readonly persistence = new Persistence();
  private storage?: Durability;
  private unavailable?: string;
  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">) {}

  get isUnavailable(): boolean {
    return this.unavailable !== undefined;
  }
  get persistenceStatus(): string {
    if (this.unavailable) return "unavailable; repair storage and reconcile/reload";
    if (this.storage?.kind === "volatile") return VOLATILE;
    if (!this.storage?.conversation) return "not persisted yet; send an ordinary message first";
    return "verified session-file record (not an fsync guarantee)";
  }
  private quarantine(message: string) {
    this.unavailable = message;
    this.generation++;
  }
  reconcile(ctx: ExtensionContext): number {
    this.generation++;
    this.owner = undefined;
    try {
      const origin = this.captureNative(ctx);
      const storage = this.persistence.inspect(ctx.sessionManager);
      if (!this.matches(origin, ctx, false)) throw new Error("Native session changed during reconciliation");
      const branch = ctx.sessionManager.getBranch();
      // getBranch stops at an absent native parent (e.g. a failed append followed
      // by a persisted tool result). A truncated path is not an empty checklist.
      if (branch.length && branch[0].parentId !== null) {
        this.quarantine(
          "Todo unavailable: unresolved native session ancestry; navigate to a verified ancestor or repair storage, then reconcile.",
        );
        return 0;
      }
      const recovered = recover(branch.filter((entry) => !isState(entry) || this.persistence.includes(storage, entry)));
      this.snapshot = recovered.snapshot;
      this.snapshotRecord = recovered.record;
      this.storage = storage;
      this.unavailable = undefined;
      this.owner = this.captureNative(ctx);
      return recovered.invalid;
    } catch {
      this.quarantine("Todo unavailable: cannot verify session storage; repair it and reconcile/reload.");
      return 0;
    }
  }
  retire() {
    this.generation++;
    this.owner = undefined;
  }
  private captureNative(ctx: ExtensionContext): Ownership {
    const branch = ctx.sessionManager.getBranch();
    return {
      manager: ctx.sessionManager,
      session: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
      prefix: branch.map(fingerprint),
      authority: authority(branch),
      generation: this.generation,
    };
  }
  private matches(owner: Ownership, ctx: ExtensionContext, checkAuthority = true): boolean {
    try {
      const branch = ctx.sessionManager.getBranch();
      return (
        owner.generation === this.generation &&
        owner.manager === ctx.sessionManager &&
        owner.session === ctx.sessionManager.getSessionId() &&
        owner.file === ctx.sessionManager.getSessionFile() &&
        owner.prefix.every((hash, index) => branch[index] && fingerprint(branch[index]) === hash) &&
        (!checkAuthority || owner.authority === authority(branch))
      );
    } catch {
      return false;
    }
  }
  assert(ctx: ExtensionContext, lease?: Ownership) {
    if (this.unavailable) throw new Error(this.unavailable);
    if (!this.owner || !this.matches(this.owner, ctx) || (lease && !this.matches(lease, ctx)))
      throw new Error("Todo ownership changed; reopen /todo or retry on the current branch.");
  }
  lease(ctx: ExtensionContext): Ownership {
    this.assert(ctx);
    return this.captureNative(ctx);
  }
  read(ctx: ExtensionContext): Snapshot {
    this.assert(ctx);
    try {
      const storage = this.persistence.inspect(ctx.sessionManager);
      if (storage.kind !== "volatile" && this.snapshotRecord && !storage.committed.has(this.snapshotRecord))
        throw new Error("Cached snapshot record no longer matches storage");
      this.assert(ctx);
      this.storage = storage;
    } catch {
      this.quarantine(
        "Todo unavailable: cached state cannot be verified against session storage; repair and reconcile/reload.",
      );
      throw new Error(this.unavailable);
    }
    return copy(this.snapshot);
  }
  mutate(ctx: ExtensionContext, input: unknown, lease?: Ownership): Snapshot {
    this.assert(ctx, lease);
    if (this.committing) throw new Error("Todo commit already in progress");
    const next = transition(this.snapshot, input);
    if (next === this.snapshot) return this.read(ctx);
    // No native write occurs until a matching readable session has a persisted conversation.
    const origin = this.lease(ctx);
    let before: Durability;
    try {
      before = this.persistence.inspect(ctx.sessionManager);
    } catch {
      this.quarantine("Todo unavailable: session file/header cannot be verified; repair storage and reconcile/reload.");
      throw new Error(this.unavailable);
    }
    this.persistence.requireWritable(before);
    const ancestors = ctx.sessionManager.getBranch();
    if (!this.matches(origin, ctx) || ancestors.length !== origin.prefix.length)
      throw new Error("Todo ownership changed during preflight; retry on the current native branch.");
    if (ancestors.length && ancestors[0].parentId !== null)
      throw new Error("Todo unavailable: unresolved native session ancestry; reconcile/reload.");
    const uncommitted = ancestors.find((entry) => !this.persistence.includes(before, entry));
    if (uncommitted)
      throw new Error(
        `Todo native branch contains an uncommitted ${isState(uncommitted) ? "state entry" : "native ancestor"}; reload the native session before editing.`,
      );
    this.storage = before;
    this.committing = true;
    try {
      let appendError: unknown;
      try {
        this.pi.appendEntry(STATE_TYPE, copy(next));
      } catch (error) {
        appendError = error;
      }
      // Check the entire previous native prefix, not just IDs, before adopting any state.
      if (!this.matches(origin, ctx, false)) {
        this.quarantine("Todo ownership changed during persistence; reconcile the current native session.");
        throw new Error(this.unavailable);
      }
      const branch = ctx.sessionManager.getBranch();
      const latest = [...branch].reverse().find(isState);
      let verified: Durability;
      try {
        verified = this.persistence.inspect(ctx.sessionManager);
      } catch {
        this.quarantine("Todo unavailable: append outcome is uncertain; repair storage and reconcile/reload.");
        throw new Error(this.unavailable);
      }
      if (
        !this.matches(origin, ctx, false) ||
        authority(ctx.sessionManager.getBranch()) !== fingerprint(latest ?? null)
      ) {
        this.quarantine("Todo ownership changed during durability verification; reconcile the native session.");
        throw new Error(this.unavailable);
      }
      const appended =
        latest?.type === "custom" &&
        branch.indexOf(latest) >= origin.prefix.length &&
        JSON.stringify(latest.data) === JSON.stringify(next) &&
        this.persistence.includes(verified, latest);
      if (!appended || verified.incomplete || (verified.kind !== "volatile" && !verified.conversation)) {
        // Cache stays old. If native memory moved, it is quarantined until explicit reconciliation.
        if (branch.length !== origin.prefix.length)
          this.quarantine(
            "Todo unavailable: append was not verified on disk; native branch may retain an uncommitted entry. Reconcile/reload.",
          );
        throw appendError ?? new Error("Todo persistence did not append a verified authoritative snapshot");
      }
      // A native exception AFTER a complete verified write is a committed operation.
      this.snapshot = next;
      this.snapshotRecord = latest ? fingerprint(latest) : undefined;
      this.storage = verified;
      this.owner = this.captureNative(ctx);
      return copy(next);
    } finally {
      this.committing = false;
    }
  }
}

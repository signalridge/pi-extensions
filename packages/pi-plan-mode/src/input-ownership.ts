import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CanonicalFingerprints } from "./canonical-fingerprint.js";
import { PLAN_IMPLEMENTATION_HANDOFF_MESSAGE_TYPE } from "./message-transform.js";

// Shared only by this loaded module: a replacement factory can authenticate
// old deliveries without retaining factories, prompt bodies or replay tokens.
const deliverySecret = randomBytes(32);
let deliverySequence = 0n;

type NativeUser = { role: string; content?: unknown; timestamp?: number };
type Input = { text: string; images?: unknown[]; source: string; streamingBehavior?: "steer" | "followUp" };
type Purpose = { revision: true } | { implementationId: string };
interface Owner {
  sessionId?: string;
  branch: string[];
  generation: number;
  manager: ExtensionContext["sessionManager"];
}
interface Delivery {
  purpose: Purpose;
  key: string;
  owner: Owner;
  expires: number;
  workflowId: string;
}
interface Candidate {
  key: string;
  real: boolean;
  owner: Owner;
  lane: "direct" | "steer" | "followUp";
  expires: number;
  delivery?: Delivery;
  literalToken?: boolean;
}
interface Binding {
  native: NativeUser;
  key: string;
  owner: Owner;
  purpose: Purpose | undefined;
  real: boolean;
  workflowId?: string;
  operation?: { ctx: ExtensionContext; signal: AbortSignal };
}
export const PLAN_HANDOFF_IDENTITY_ENTRY = "plan-mode-handoff-identity";
interface HandoffIdentity {
  version: 1;
  sessionId: string;
  nativeId: string;
  key: string;
  timestamp: number;
  implementationId: string;
  workflowId: string;
}

function textOf(content: unknown) {
  return Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : typeof content === "string"
      ? content
      : "";
}
function isIdentity(value: unknown): value is HandoffIdentity {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<HandoffIdentity>;
  return (
    data.version === 1 &&
    typeof data.sessionId === "string" &&
    data.sessionId.length > 0 &&
    data.sessionId.length <= 256 &&
    typeof data.nativeId === "string" &&
    data.nativeId.length > 0 &&
    data.nativeId.length <= 256 &&
    typeof data.key === "string" &&
    /^[a-f0-9]{64}$/u.test(data.key) &&
    typeof data.timestamp === "number" &&
    Number.isSafeInteger(data.timestamp) &&
    data.timestamp >= 0 &&
    typeof data.implementationId === "string" &&
    data.implementationId.length > 0 &&
    data.implementationId.length <= 256 &&
    typeof data.workflowId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(data.workflowId)
  );
}

/** Accepted-native authority is transient. Handoff attribution is compact,
 * validated branch-local metadata, never a prose-prefix classification. */
export class PlanInputOwnership {
  private pending: Candidate[] = [];
  private uncertain = false;
  private deliveries = new Map<string, Delivery>();
  private binding?: Binding;
  private seen = new WeakSet<object>();
  private uncommittedHandoffs: Binding[] = [];
  private observed?: Owner;
  private revisionNatives = new WeakSet<object>();
  private tickets = new Map<string, Binding | null>();
  // Bounded, request-local tombstones for authenticated deliveries accepted
  // after their workflow retired. Never infer ownership from handoff prose.
  private retiredNatives: Array<{ key: string; timestamp?: number; owner: Owner }> = [];

  constructor(
    private appendIdentity: (data: HandoffIdentity) => void = () => {},
    private fingerprints = new CanonicalFingerprints(),
  ) {}

  private contentKey = (content: unknown) => this.fingerprints.key(content);

  private capture(ctx: ExtensionContext, generation: number): Owner {
    return {
      sessionId: ctx.sessionManager.getSessionId?.(),
      branch: ctx.sessionManager.getBranch().map(this.contentKey),
      generation,
      manager: ctx.sessionManager,
    };
  }
  private current(owner: Owner, ctx: ExtensionContext, generation: number) {
    return this.matches(owner, this.capture(ctx, generation));
  }
  private matches(owner: Owner, live: Owner) {
    return (
      owner.manager === live.manager &&
      owner.generation === live.generation &&
      owner.sessionId === live.sessionId &&
      owner.branch.every((id, index) => live.branch[index] === id)
    );
  }
  private prune() {
    const now = Date.now();
    const pending = this.pending.filter((candidate) => candidate.expires > now).slice(-256);
    if (pending.length !== this.pending.length) this.uncertain = true;
    this.pending = pending;
    for (const [token, delivery] of this.deliveries) {
      if (delivery.expires <= now) this.deliveries.delete(token);
    }
    while (this.deliveries.size > 128) {
      const oldest = this.deliveries.keys().next().value;
      if (oldest === undefined) break;
      this.deliveries.delete(oldest);
    }
  }
  private live(ctx: ExtensionContext, generation: number) {
    const fallbacks = this.fingerprints.fallbacks;
    const live = this.capture(ctx, generation);
    if (this.observed && !this.matches(this.observed, live)) {
      // reset may abort through a host callback: always recapture afterwards.
      this.reset();
      this.observed = this.capture(ctx, generation);
    } else {
      // Deduplicate only inert own-data reads. Exotic stringify callbacks keep
      // the original second capture, never reuse proof across arbitrary code.
      this.observed = this.observed && fallbacks !== this.fingerprints.fallbacks ? this.capture(ctx, generation) : live;
    }
    this.prune();
  }
  private token(text: string) {
    const match = /(?:^|\n\n)(<!-- pi-plan-delivery:(\d+):([a-f0-9]{64}) -->)$/u.exec(text);
    return match && createHmac("sha256", deliverySecret).update(match[2]).digest("hex") === match[3]
      ? match[1]
      : undefined;
  }

  send(
    text: string,
    purpose: Purpose | { implementationId: string; plan: string },
    ctx: ExtensionContext,
    generation: number,
  ) {
    if (!ctx.sessionManager) return text;
    this.live(ctx, generation);
    const sequence = String(++deliverySequence);
    const token = `<!-- pi-plan-delivery:${sequence}:${createHmac("sha256", deliverySecret).update(sequence).digest("hex")} -->`;
    this.deliveries.set(token, {
      purpose: "revision" in purpose ? { revision: true } : { implementationId: purpose.implementationId },
      key: this.contentKey([{ type: "text", text: `${text}\n\n${token}` }]),
      owner: this.capture(ctx, generation),
      expires: Date.now() + 300_000,
      workflowId: randomUUID(),
    });
    this.prune();
    return `${text}\n\n${token}`;
  }

  input(input: Input, ctx: ExtensionContext, generation: number) {
    this.live(ctx, generation);
    const token = input.source === "extension" ? this.token(input.text) : undefined;
    const delivery = token ? this.deliveries.get(token) : undefined;
    if (
      token &&
      (!delivery ||
        this.contentKey([{ type: "text", text: input.text }, ...(input.images ?? [])]) !== delivery.key ||
        !this.current(delivery.owner, ctx, generation))
    )
      return { action: "handled" as const };
    const real = input.source === "interactive" || input.source === "rpc";
    const literalToken = real && Boolean(this.token(input.text));
    this.pending.push({
      key: this.contentKey([{ type: "text", text: input.text }, ...(input.images ?? [])]),
      real,
      literalToken,
      owner: this.capture(ctx, generation),
      delivery,
      lane: input.streamingBehavior ?? "direct",
      // Bounded positive-input exemptions cannot expire into a token rejection
      // while a later handler awaits. They confer no extension authority.
      expires: literalToken ? Number.POSITIVE_INFINITY : Date.now() + 300_000,
    });
    this.prune();
    return { action: "continue" as const };
  }

  message(message: NativeUser, ctx: ExtensionContext, generation: number) {
    if (message.role !== "user") return;
    this.live(ctx, generation);
    this.commitHandoffs(ctx, generation);
    if (this.seen.has(message)) {
      if (this.binding?.native !== message) this.binding = undefined;
      return;
    }
    this.seen.add(message);
    const key = this.contentKey(message.content);
    // Known lanes can drain out of input order. Distinct content cannot erase
    // an exact unique candidate; same-content collisions in any lane fail shut.
    const matches = this.pending.filter((candidate) => candidate.key === key);
    const candidate = !this.uncertain && matches.length === 1 ? matches[0] : undefined;
    const position = candidate ? this.pending.indexOf(candidate) : -1;
    // Only known streaming lanes have a FIFO watermark. Observing this lane's
    // native delivery retires earlier handled/transformed candidates in that
    // lane, not pending work in the other lane. Direct input has no such proof.
    this.pending = this.pending.filter(
      (entry, index) =>
        entry.key !== key &&
        (!candidate || candidate.lane === "direct" || entry.lane !== candidate.lane || index > position),
    );
    this.binding = undefined;
    for (const id of this.tickets.keys()) this.tickets.set(id, null);
    const nativeToken = this.token(textOf(message.content));
    const realLiteral = matches.length === 1 && matches[0]?.literalToken;
    if (
      nativeToken &&
      !realLiteral &&
      (!candidate?.delivery ||
        candidate.delivery.key !== key ||
        !this.current(candidate.owner, ctx, generation) ||
        this.deliveries.get(nativeToken) !== candidate.delivery)
    ) {
      this.retiredNatives.push({
        key,
        timestamp: message.timestamp,
        owner: this.capture(ctx, generation),
      });
      this.retiredNatives = this.retiredNatives.slice(-128);
      this.deliveries.delete(nativeToken);
      return { retired: true };
    }
    if (candidate && this.current(candidate.owner, ctx, generation)) {
      const delivery = candidate.delivery;
      const token = this.token(textOf(message.content));
      if (
        !delivery ||
        (token && this.deliveries.get(token) === delivery && this.current(delivery.owner, ctx, generation))
      ) {
        this.binding = {
          native: message,
          key,
          owner: candidate.owner,
          purpose: delivery?.purpose,
          real: candidate.real,
          workflowId: delivery?.workflowId,
          operation: delivery && ctx.signal ? { ctx, signal: ctx.signal } : undefined,
        };
        if (delivery && token) {
          this.deliveries.delete(token);
          if ("implementationId" in delivery.purpose) {
            this.uncommittedHandoffs.push(this.binding);
            this.uncommittedHandoffs = this.uncommittedHandoffs.slice(-128);
          }
        }
      }
    }
  }

  authorized(ctx: ExtensionContext, generation: number) {
    this.live(ctx, generation);
    const binding = this.binding;
    const nativeOnBranch =
      binding &&
      ctx.sessionManager
        .getBranch()
        .some(
          (entry, index) =>
            index >= binding.owner.branch.length &&
            entry.type === "message" &&
            entry.message.role === "user" &&
            entry.message.timestamp === binding.native.timestamp &&
            this.contentKey(entry.message.content) === binding.key,
        );
    return Boolean(
      binding &&
        this.contentKey(binding.native.content) === binding.key &&
        nativeOnBranch &&
        this.current(binding.owner, ctx, generation) &&
        (binding.real || (binding.purpose && "revision" in binding.purpose)),
    );
  }

  authorizeCall(id: string, ctx: ExtensionContext, generation: number) {
    if (!this.authorized(ctx, generation) || !this.binding || this.tickets.has(id)) return false;
    if (this.tickets.size >= 128) return false;
    this.tickets.set(id, this.binding);
    return true;
  }
  consumeCall(id: string, ctx: ExtensionContext, generation: number) {
    const ticket = this.tickets.get(id);
    if (this.tickets.has(id)) this.tickets.set(id, null);
    return Boolean(ticket && ticket === this.binding && this.authorized(ctx, generation));
  }

  revisionStarted(ctx: ExtensionContext, generation: number) {
    this.live(ctx, generation);
    const binding = this.binding;
    // message_start is acceptance, before SessionManager commits the message.
    if (
      !binding ||
      this.revisionNatives.has(binding.native) ||
      !this.current(binding.owner, ctx, generation) ||
      !(binding.real || (binding.purpose && "revision" in binding.purpose))
    )
      return false;
    this.revisionNatives.add(binding.native);
    return true;
  }

  /** Persist only after finding the exact committed native branch entry. */
  commitHandoffs(ctx: ExtensionContext, _generation: number) {
    const branch = ctx.sessionManager.getBranch();
    const remaining: Binding[] = [];
    for (const binding of this.uncommittedHandoffs) {
      const purpose = binding.purpose;
      if (!purpose || !("implementationId" in purpose) || !binding.workflowId || !binding.owner.sessionId) continue;
      // Generation retires authority, not accepted native provenance.
      if (!this.current(binding.owner, ctx, binding.owner.generation)) {
        remaining.push(binding);
        continue;
      }
      const native = branch.find(
        (entry, index) =>
          index >= binding.owner.branch.length &&
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.timestamp === binding.native.timestamp &&
          this.contentKey(entry.message.content) === binding.key,
      );
      if (!native) {
        remaining.push(binding);
        continue;
      }
      if (binding.native.timestamp === undefined || this.contentKey(binding.native.content) !== binding.key) continue;
      this.appendIdentity({
        version: 1,
        sessionId: binding.owner.sessionId,
        nativeId: native.id,
        key: binding.key,
        timestamp: binding.native.timestamp,
        implementationId: purpose.implementationId,
        workflowId: binding.workflowId,
      });
    }
    this.uncommittedHandoffs = remaining;
  }

  context<T extends NativeUser>(
    messages: T[],
    ctx: ExtensionContext,
    generation: number,
    active?: { id: string; plan: string },
  ) {
    this.live(ctx, generation);
    this.commitHandoffs(ctx, generation);
    const branch = ctx.sessionManager.getBranch();
    // No lifetime attribution cache: reconcile from the public active branch
    // every time. Fingerprints independently revalidate raw values on each hit,
    // so compaction, mutation and session replacement cannot leak provenance.
    const users = messages.filter((message) => message.role === "user");
    const timestamps = new Set(users.map((message) => message.timestamp));
    const relevant = new Set(users.map((message) => `${message.timestamp}:${this.contentKey(message.content)}`));
    const nativeEntries = new Map(
      branch
        .filter(
          (entry) =>
            entry.type === "message" && entry.message.role === "user" && timestamps.has(entry.message.timestamp),
        )
        .map((entry) => [entry.id, entry]),
    );
    const identities = new Map<string, HandoffIdentity | null>();
    const counts = new Map<string, number>();
    for (const entry of nativeEntries.values()) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const key = `${entry.message.timestamp}:${this.contentKey(entry.message.content)}`;
      if (relevant.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== PLAN_HANDOFF_IDENTITY_ENTRY || !isIdentity(entry.data))
        continue;
      const data = entry.data;
      if (!relevant.has(`${data.timestamp}:${data.key}`)) continue;
      const native = nativeEntries.get(data.nativeId);
      if (
        data.sessionId !== ctx.sessionManager.getSessionId?.() ||
        !native ||
        native.type !== "message" ||
        native.message.role !== "user" ||
        native.message.timestamp !== data.timestamp ||
        this.contentKey(native.message.content) !== data.key ||
        !Array.isArray(native.message.content) ||
        native.message.content.length !== 1 ||
        native.message.content[0]?.type !== "text" ||
        !/\n\n<!-- pi-plan-delivery:\d+:[a-f0-9]{64} -->$/u.test(textOf(native.message.content))
      )
        continue;
      const identity = `${data.timestamp}:${data.key}`;
      identities.set(identity, identities.has(identity) || counts.get(identity) !== 1 ? null : data);
    }
    return messages.map((message) => {
      if (message.role !== "user") return message;
      const key = this.contentKey(message.content);
      const retired = this.retiredNatives.some(
        (entry) =>
          entry.timestamp === message.timestamp &&
          entry.key === key &&
          entry.owner.manager === ctx.sessionManager &&
          entry.owner.sessionId === ctx.sessionManager.getSessionId?.() &&
          entry.owner.branch.every(
            (key, index) => branch[index] !== undefined && this.contentKey(branch[index]) === key,
          ),
      );
      // Exact accepted native provenance only; the original storage is untouched.
      if (retired && counts.get(`${message.timestamp}:${key}`) === 1) return { ...message, content: [] };
      const identity = identities.get(`${message.timestamp}:${key}`);
      if (!identity) return message;
      const current = active?.id === identity.implementationId;
      return {
        role: "custom" as const,
        customType: PLAN_IMPLEMENTATION_HANDOFF_MESSAGE_TYPE,
        content: current ? textOf(message.content).replace(/\n\n<!-- pi-plan-delivery:\d+:[a-f0-9]{64} -->$/u, "") : "",
        details: { implementationId: identity.implementationId, plan: current ? active.plan : "" },
        display: false,
        timestamp: message.timestamp ?? Date.now(),
      };
    });
  }

  settled() {
    this.pending = this.pending.filter(
      (candidate) => candidate.literalToken || (candidate.delivery && candidate.expires > Date.now()),
    );
    this.uncertain = false;
    this.binding = undefined;
    this.revisionNatives = new WeakSet();
    this.seen = new WeakSet();
    this.tickets.clear();
    this.prune();
  }
  reset(retireOperation = true) {
    const binding = this.binding;
    const operation = binding?.operation;
    // Context controls are live getters. Compare the captured signal before
    // aborting, and only the latest positively owned native, never a new root.
    if (
      retireOperation &&
      binding?.purpose &&
      "implementationId" in binding.purpose &&
      operation &&
      !operation.signal.aborted &&
      operation.ctx.signal === operation.signal
    )
      operation.ctx.abort();
    // Later input handlers may still be awaiting. Keep bounded candidate
    // provenance, not authority, so their eventual native acceptance is fenced.
    const pending = this.pending;
    const uncertain = this.uncertain;
    this.settled();
    this.pending = pending;
    this.uncertain = pending.length > 0 && uncertain;
    this.prune();
    this.deliveries.clear();
    this.observed = undefined;
    this.fingerprints.clear();
  }
}

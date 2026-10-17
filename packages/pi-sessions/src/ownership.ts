import { createHash } from "node:crypto";
import type { ExtensionCommandContext, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

export class Retired extends Error {
  constructor() {
    super("Session interaction retired");
  }
}

export function branchFingerprint(ctx: ExtensionContext): string {
  // All native data, not just a leaf ID or the model-visible messages. This also catches
  // context edits and same-leaf in-place changes before a delayed lifecycle event arrives.
  return createHash("sha256").update(JSON.stringify(ctx.sessionManager.getBranch())).digest("hex");
}

export function modelIdentity(ctx: Pick<ExtensionContext, "model">): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
}

function selectedModelFingerprint(ctx: Pick<ExtensionContext, "model">): string {
  return createHash("sha256")
    .update(JSON.stringify(ctx.model ?? null))
    .digest("hex");
}

export class Owner<Context extends ExtensionContext = ExtensionCommandContext> {
  readonly controller = new AbortController();
  readonly manager;
  readonly id: string;
  readonly file: string | undefined;
  readonly fingerprint: string;
  readonly model: string;
  private readonly modelData: string;
  readonly draft: string | undefined;
  readonly editorFactory;
  committing: "new" | "resume" | undefined;
  // One delivered preflight belongs to our initiated replacement. Keep the
  // committing marker separately: shutdown must retain recovery after revocation.
  expectedSwitch = false;
  target: string | undefined;
  replacementStarted = false;
  replacementApproved = false;
  private retired = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    readonly ctx: Context,
    readonly requireModel: boolean,
  ) {
    this.manager = ctx.sessionManager;
    this.id = this.manager.getSessionId();
    this.file = this.manager.getSessionFile();
    this.fingerprint = branchFingerprint(ctx);
    this.model = modelIdentity(ctx);
    this.modelData = selectedModelFingerprint(ctx);
    this.draft = ctx.mode === "tui" ? ctx.ui.getEditorText() : undefined;
    this.editorFactory = ctx.mode === "tui" ? ctx.ui.getEditorComponent() : undefined;
    this.timer = setInterval(() => this.current(), 75);
    this.timer.unref();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  current(): boolean {
    if (this.retired) return false;
    try {
      if (
        this.ctx.sessionManager !== this.manager ||
        this.manager.getSessionId() !== this.id ||
        this.manager.getSessionFile() !== this.file ||
        branchFingerprint(this.ctx) !== this.fingerprint ||
        (this.requireModel &&
          (modelIdentity(this.ctx) !== this.model || selectedModelFingerprint(this.ctx) !== this.modelData)) ||
        (this.draft !== undefined &&
          (this.ctx.ui.getEditorText() !== this.draft || this.ctx.ui.getEditorComponent() !== this.editorFactory))
      ) {
        this.retire();
      }
    } catch {
      this.retire();
    }
    return !this.retired;
  }

  check(): void {
    if (!this.current()) throw new Retired();
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    clearInterval(this.timer);
    this.controller.abort();
  }

  shutdown(event: SessionShutdownEvent): void {
    // Retain recovery data once native replacement begins, even when approval
    // was revoked during a later asynchronous before-switch handler. Only a
    // still-current owner may carry prefill approval across normal teardown.
    if (this.committing && event.reason === this.committing) {
      this.replacementStarted = true;
      this.replacementApproved = this.current();
    }
    this.retire();
  }

  finish(): void {
    this.retire();
  }

  /** Stop waiting promptly even if a provider or RPC editor ignores cancellation.
   * Late results are consumed, never allowed to mutate the retired owner. */
  async wait<T>(work: Promise<T>): Promise<T> {
    if (!this.current()) {
      void work.catch(() => {});
      throw new Retired();
    }
    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Retired());
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const value = await Promise.race([work, cancellation]);
      this.check();
      return value;
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }
}

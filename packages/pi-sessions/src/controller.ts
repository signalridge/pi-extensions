import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handoff, prefillHandoff } from "./handoff.js";
import { navigate } from "./navigation.js";
import { Owner, Retired } from "./ownership.js";
import { requireHuman } from "./ui.js";

export function registerSessions(pi: ExtensionAPI): void {
  let active: Owner<ExtensionContext> | undefined;
  let started = false;
  const retire = () => active?.retire();
  pi.on("session_before_switch", (event) => {
    if (!active) return;
    if (
      active.expectedSwitch &&
      active.committing === event.reason &&
      (event.reason !== "resume" || event.targetSessionFile === active.target)
    ) {
      active.expectedSwitch = false;
      if (!active.current()) return { cancel: true };
    } else retire();
  });
  pi.on("session_shutdown", (event) => active?.shutdown(event));
  pi.on("session_before_tree", retire);
  pi.on("session_before_fork", retire);
  pi.on("session_before_compact", retire);
  pi.on("session_tree", retire);
  pi.on("agent_start", retire);
  pi.on("model_select", () => {
    if (active?.requireModel) retire();
  });

  pi.on("session_start", async (event, ctx) => {
    // Native setup precedes destination binding. Recovery starts never consume
    // persisted intent; only this fresh runtime's first, genuinely new session can.
    if (started) return;
    started = true;
    if (event.reason !== "new" || !ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
    await own(ctx, true, prefillHandoff);
  });

  async function own<Context extends ExtensionContext>(
    ctx: Context,
    requireModel: boolean,
    work: (owner: Owner<Context>) => Promise<void>,
  ): Promise<void> {
    if (active) {
      ctx.ui.notify("A sessions interaction is already open. Finish or cancel it first.", "warning");
      return;
    }
    const owner = new Owner(ctx, requireModel);
    active = owner;
    try {
      await work(owner);
    } catch (error: unknown) {
      if (!(error instanceof Retired) && owner.current()) {
        ctx.ui.notify(
          "Session operation unavailable: invalid/unreadable session, workspace or UI. No model turn was submitted. Retry from the current session.",
          "warning",
        );
      }
    } finally {
      owner.finish();
      if (active === owner) active = undefined;
    }
  }
  async function run(ctx: ExtensionCommandContext, argument: string, kind: "sessions" | "handoff"): Promise<void> {
    // Reject headless commands before idle/auth/session operations.
    requireHuman(ctx);
    await own(ctx, kind === "handoff", async (owner) => {
      await owner.wait(ctx.waitForIdle());
      owner.check();
      if (kind === "sessions") await navigate(owner, argument);
      else await handoff(owner, argument);
    });
  }
  pi.registerCommand("sessions", {
    description: "Preview/resume current-workspace sessions; 'all' includes other workspaces",
    handler: (args, ctx) => run(ctx, args, "sessions"),
  });
  pi.registerCommand("handoff", {
    description: "Review a goal-oriented summary into a linked session, or explicitly 'recover' one",
    handler: (args, ctx) => run(ctx, args, "handoff"),
  });
}

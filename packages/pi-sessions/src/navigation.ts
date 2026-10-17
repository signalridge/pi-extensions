import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Owner } from "./ownership.js";
import { vetSession } from "./storage.js";
import { label, PREVIEW_BYTES } from "./text.js";
import { HumanUI, isSessionInfo, rowKey, rowsFrom, type SessionRow } from "./ui.js";

type SessionListProgress = NonNullable<Parameters<typeof SessionManager.list>[2]>;

export async function navigate(owner: Owner, argument: string): Promise<void> {
  const { ctx } = owner;
  const scope = argument.trim();
  if (scope && scope !== "all") {
    ctx.ui.notify("Usage: /sessions [all]", "warning");
    return;
  }
  const ui = new HumanUI(owner);
  const all = scope === "all";
  const chosen = await ui.pick(async (publish, signal) => {
    const progress: SessionListProgress = (loaded, total, partial) => {
      if (partial && owner.current() && !signal.aborted) {
        const valid = partial.filter(isSessionInfo);
        publish(rowsFrom(all ? valid : valid.filter((s) => s.cwd === ctx.cwd)), loaded, total, false);
      }
    };
    // The SDK loads full SessionInfo values. Only our retained/presented rows are
    // bounded; never claim SDK list memory is bounded.
    let sessions: SessionInfo[];
    if (all) {
      const [global, local] = await Promise.all([
        SessionManager.listAll(progress, signal),
        SessionManager.listAll(ctx.sessionManager.getSessionDir(), undefined, signal),
      ]);
      const unique = new Map<string, SessionInfo>();
      for (const info of [...global, ...local].filter(isSessionInfo)) unique.set(rowKey(info), info);
      sessions = [...unique.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } else sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir(), progress, signal);
    signal.throwIfAborted();
    owner.check();
    sessions = sessions.filter(isSessionInfo);
    const rows = rowsFrom(all ? sessions : sessions.filter((s) => s.cwd === ctx.cwd));
    publish(rows, sessions.length, sessions.length, true);
    return rows;
  });
  owner.check();
  if (!chosen) return;
  if (!all && chosen.cwd !== ctx.cwd) throw new Error("Explicit all-workspace scope required");
  await switchChosen(owner, ui, chosen);
}

async function switchChosen(owner: Owner, ui: HumanUI, chosen: SessionRow): Promise<void> {
  const { ctx } = owner;
  const candidate = await owner.wait(vetSession(chosen.path, chosen.id, owner.signal));
  owner.check();
  if (candidate.header.cwd !== chosen.cwd) throw new Error("Session workspace changed");
  const crossWorkspace = candidate.header.cwd !== ctx.cwd;
  if (
    crossWorkspace &&
    !(await ui.confirm(
      "Cross-workspace session",
      `History belongs to: ${label(candidate.header.cwd, 600)}\nActive workspace now: ${label(ctx.cwd, 600)}\nPi 1.0.4 native switching rebinds tools/resources to the session workspace (not process.chdir). Other hosts may retain their workspace; the actual active workspace will be reported after switching. Continue?`,
    ))
  )
    return;
  if (
    !(await ui.confirm(
      "Preview and resume session?",
      `Session: ${label(chosen.id)}\nWorkspace: ${label(candidate.header.cwd, 600)}\n${candidate.preview || "(No user/assistant text)"}\nPreview limited to ${PREVIEW_BYTES} bytes; it is inert text. Resume this history? No turn will run.`,
    ))
  )
    return;
  if (ctx.mode === "rpc" || owner.draft) {
    if (
      !(await ui.confirm(
        "Leave current unsent draft?",
        "Switching sessions may discard your current editor draft. Save it first. Allow this native session switch?",
      ))
    )
      return;
  }
  owner.check();
  // Re-read header/tree/content immediately before the native call; ID+path are
  // authoritative, never a label or array index. No preview prompt is executed.
  const verified = await owner.wait(vetSession(chosen.path, chosen.id, owner.signal));
  if (verified.header.cwd !== candidate.header.cwd || verified.digest !== candidate.digest) {
    ctx.ui.notify("Session changed after preview. Nothing switched; reopen /sessions.", "warning");
    return;
  }
  owner.check();
  owner.committing = "resume";
  owner.target = chosen.path;
  owner.expectedSwitch = true;
  const result = await ctx.switchSession(chosen.path, {
    withSession: async (destination) => {
      owner.replacementStarted = true;
      destination.ui.notify(
        `Restored history from ${label(verified.header.cwd, 500)}. Active tool/resource workspace: ${label(destination.cwd, 500)}. ${destination.cwd === verified.header.cwd ? "Native workspace rebind completed." : "Execution workspace was retained; history is NOT a workspace change."} No model turn was submitted.`,
        destination.cwd === verified.header.cwd ? "info" : "warning",
      );
    },
  });
  if (result.cancelled && owner.current())
    ctx.ui.notify("Session switch cancelled; original session retained.", "info");
}

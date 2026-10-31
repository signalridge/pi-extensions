import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CANONICAL_HISTORY_NOTICE =
  "This compaction sends Pi's persisted canonical history, including custom content, system instructions, and tools. It bypasses request-local context filters; content hidden from ordinary model requests may be sent, retained in the checkpoint, and replayed later. Persisted context_edit omissions remain honored. Bounded full-history folding can make up to eight HTTP attempts per operation, including retries, adding latency and cost; heuristic sizing does not guarantee fit. Defaults allow five minutes per stage and fifteen minutes total, including authentication and retries; explicit existing total limits remain honored and incoming bytes never extend deadlines. Source-free phase/count/usage diagnostics are stored separately from session history. Only a complete final fold is committed, never an intermediate prefix; failed folds preserve existing opaque history. If remote compaction fails, Pi's native summary may use this same canonical history. Allow once? This does not change your settings.";

/** No credentials, history excerpts, or destination URLs belong in this dialog. */
export async function authorizeCanonicalHistory(ctx: ExtensionContext, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || ctx.mode !== "tui" || !ctx.hasUI) return false;
  const controller = new AbortController();
  const dialogSignal = AbortSignal.any([signal, controller.signal]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  try {
    const interrupted = new Promise<false>((resolve) => {
      onAbort = () => resolve(false);
      dialogSignal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => controller.abort(), 300_000);
    });
    return (
      (await Promise.race([
        ctx.ui.confirm("Codex compaction · Allow canonical history once?", CANONICAL_HISTORY_NOTICE, {
          signal: dialogSignal,
          timeout: 300_000,
        }),
        interrupted,
      ])) === true && !dialogSignal.aborted
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    dialogSignal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

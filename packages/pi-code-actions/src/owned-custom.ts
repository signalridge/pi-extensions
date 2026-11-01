import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";

export interface ActionOwnership {
  signal: AbortSignal;
  isCurrent(): boolean;
}

type DisposableComponent = Component & { dispose?(): void };

/** Synchronous factories let retirement close Pi's captured draft before navigation writes the next one. */
export async function ownedCustom<T>(
  ctx: ExtensionCommandContext,
  ownership: ActionOwnership,
  factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => DisposableComponent,
): Promise<T | undefined> {
  if (!ownership.isCurrent() || ownership.signal.aborted || ctx.mode !== "tui" || !ctx.hasUI) return undefined;
  let closed = false;
  let disposed = false;
  let component: DisposableComponent | undefined;
  let rawDone: ((value: T | undefined) => void) | undefined;
  let listening = false;
  let retire!: () => void;
  const retired = new Promise<undefined>((resolve) => {
    retire = () => resolve(undefined);
  });
  const cleanup = () => {
    if (!listening) return;
    listening = false;
    ownership.signal.removeEventListener("abort", onAbort);
  };
  const dispose = () => {
    if (!component || disposed) return;
    disposed = true;
    try {
      component.dispose?.();
    } catch {
      // Match Pi's best-effort disposal without preventing synchronous retirement.
    }
  };
  const finish = (value: T | undefined) => {
    if (closed) return;
    closed = true;
    cleanup();
    // Do not defer this to an await continuation: Pi restores the saved draft here.
    rawDone?.(value);
    dispose();
  };
  const onAbort = () => finish(undefined);
  const active = () => !closed && !ownership.signal.aborted && ownership.isCurrent();
  try {
    const dialog = ctx.ui.custom<T | undefined>((tui, theme, keys, done) => {
      rawDone = done;
      listening = true;
      ownership.signal.addEventListener("abort", onAbort, { once: true });
      if (!active()) onAbort();
      component = factory(tui, theme, keys, (value) => {
        if (active()) finish(value);
      });
      if (closed) dispose(); // Pi does not dispose a component closed before mounting.
      return {
        render: (width) => (active() ? (component?.render(width) ?? []) : []),
        invalidate: () => {
          if (active()) component?.invalidate();
        },
        handleInput: (data) => {
          if (active()) component?.handleInput?.(data);
        },
        dispose: () => {
          // Host reset owns its dialog stack iteration. Calling rawDone here
          // would splice that same stack and skip the next foreign dialog.
          // Release our owner locally; explicit finish still closes synchronously.
          if (!closed) {
            closed = true;
            retire();
          }
          cleanup();
          dispose();
        },
      };
    });
    const result = await Promise.race([dialog, retired]);
    return ownership.isCurrent() && !ownership.signal.aborted ? result : undefined;
  } finally {
    closed = true;
    cleanup();
    dispose();
  }
}

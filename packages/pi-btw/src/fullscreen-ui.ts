import { spawn } from "node:child_process";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, type TUI, TuiAltScreen, truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeSingleLine } from "./text.js";

type BtwCustomOptions = Parameters<ExtensionCommandContext["ui"]["custom"]>[1];
type BtwCustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

type BtwFullscreenTui = TUI & { flash?: (message: string, durationMs?: number) => void };

export type BtwFullscreenTuiFactory = (parent: TUI) => BtwFullscreenTui;

export interface BtwFullscreenDependencies {
  createTui?: BtwFullscreenTuiFactory;
  openUrl?: (url: string) => void;
}

export type RunBtwFullscreen = <T>(
  ctx: ExtensionCommandContext,
  run: (ctx: ExtensionCommandContext) => Promise<T>,
) => Promise<T>;

type FullscreenOutcome<T> = { kind: "completed"; value: T } | { kind: "failed"; error: unknown };

class FullscreenUiDisposedError extends Error {
  constructor() {
    super("The dedicated pi-btw UI was disposed.");
    this.name = "FullscreenUiDisposedError";
  }
}

export async function runBtwFullscreen<T>(
  ctx: ExtensionCommandContext,
  run: (ctx: ExtensionCommandContext) => Promise<T>,
  dependencies: BtwFullscreenDependencies = {},
): Promise<T> {
  const createTui =
    dependencies.createTui ??
    ((parent: TUI) => createBtwFullscreenTui(parent, dependencies.openUrl ?? openUrlInBrowser));
  let liveEditorText = ctx.ui.getEditorText();
  let restoreEditor = false;
  const outcome = await ctx.ui.custom<FullscreenOutcome<T>>(
    (parent, theme, keybindings, done) =>
      new BtwFullscreenHost(
        parent,
        theme,
        keybindings,
        ctx,
        run,
        (value) => {
          try {
            liveEditorText = ctx.ui.getEditorText();
            restoreEditor = true;
          } catch {
            // A replaced session owns a different editor and must not receive stale text.
          }
          done(value);
        },
        createTui,
      ),
  );
  if (restoreEditor) {
    try {
      if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
    } catch {
      // A replaced session owns a different editor and must not receive stale restoration.
    }
  }
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.value;
}

function createBtwFullscreenTui(parent: TUI, openUrl: (url: string) => void): BtwFullscreenTui {
  return new TuiAltScreen(parent.terminal, parent.getShowHardwareCursor(), undefined, {
    mouse: true,
    openUrl,
  });
}

// Pi does not export its browser opener, so mirror its shell-free launcher for this isolated TUI.
function openUrlInBrowser(target: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

class BtwFullscreenHost<T> implements Component {
  private fullscreen: BtwFullscreenTui | undefined;
  private cancelActiveCustom: (() => void) | undefined;
  private started = false;
  private disposed = false;
  private finished = false;

  constructor(
    private readonly parent: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly ctx: ExtensionCommandContext,
    private readonly run: (ctx: ExtensionCommandContext) => Promise<T>,
    private readonly done: (outcome: FullscreenOutcome<T>) => void,
    private readonly createTui: BtwFullscreenTuiFactory,
  ) {
    queueMicrotask(() => void this.start());
  }

  render(width: number): string[] {
    return [truncateToWidth(this.theme.fg("muted", "Opening btw side thread…"), width)];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed || this.finished) return;
    this.disposed = true;
    this.cancelActiveCustom?.();
  }

  private async start(): Promise<void> {
    if (this.started || this.finished) return;
    this.started = true;
    let outcome: FullscreenOutcome<T>;
    let parentStopped = false;
    let fullscreenCreated = false;
    try {
      if (this.disposed) throw new FullscreenUiDisposedError();
      this.parent.stop({ preserveScreen: true });
      parentStopped = true;
      if (this.disposed) throw new FullscreenUiDisposedError();
      this.fullscreen = this.createTui(this.parent);
      fullscreenCreated = true;
      this.fullscreen.start();
      outcome = { kind: "completed", value: await this.run(this.createContext()) };
    } catch (error) {
      outcome = { kind: "failed", error };
    }

    let cleanupError: unknown;
    try {
      this.cancelActiveCustom?.();
    } catch (error) {
      cleanupError = error;
    }
    if (fullscreenCreated) {
      try {
        this.fullscreen?.stop({ preserveScreen: true });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (parentStopped) {
      try {
        this.parent.start();
        this.parent.renderNow(false);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError !== undefined) outcome = { kind: "failed", error: cleanupError };
    this.finished = true;
    this.done(outcome);
  }

  private createContext(): ExtensionCommandContext {
    const ui = new Proxy(this.ctx.ui, {
      get: (target, property) => {
        if (property === "custom") {
          return <Value>(factory: BtwCustomFactory<Value>, options?: BtwCustomOptions) =>
            this.showCustom(factory, options);
        }
        if (property === "notify") {
          return (message: string, level?: Parameters<ExtensionCommandContext["ui"]["notify"]>[1]) => {
            target.notify(message, level);
            const display = sanitizeSingleLine(message);
            if (display) this.fullscreen?.flash?.(display);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(this.ctx, {
      get: (target, property) => (property === "ui" ? ui : Reflect.get(target, property, target)),
    });
  }

  private showCustom<Value>(factory: BtwCustomFactory<Value>, options?: BtwCustomOptions): Promise<Value> {
    const fullscreen = this.fullscreen;
    if (!fullscreen || this.disposed || this.finished) {
      return Promise.reject(new FullscreenUiDisposedError());
    }
    if (this.cancelActiveCustom) {
      return Promise.reject(new Error("pi-btw attempted to open overlapping custom UI."));
    }

    return new Promise<Value>((resolve, reject) => {
      let component: (Component & { dispose?(): void }) | undefined;
      let overlay: OverlayHandle | undefined;
      let mounted = false;
      let factorySettled = false;
      let closed = false;
      let promiseSettled = false;
      let componentDisposed = false;
      let pendingValue: Value | undefined;
      let hasPendingValue = false;

      const disposeComponent = () => {
        if (!component || componentDisposed) return;
        componentDisposed = true;
        try {
          component.dispose?.();
        } catch {
          // Cleanup must continue so terminal ownership is restored.
        }
      };
      const unmount = () => {
        let cleanupError: unknown;
        try {
          if (overlay) overlay.hide();
          else if (mounted && component) fullscreen.removeChild(component);
        } catch (error) {
          cleanupError = error;
        }
        if (overlay || mounted) {
          try {
            fullscreen.setFocus(null);
            fullscreen.requestRender();
          } catch (error) {
            cleanupError ??= error;
          }
        }
        disposeComponent();
        if (cleanupError !== undefined) throw cleanupError;
      };
      const complete = () => {
        if (promiseSettled || !hasPendingValue) return;
        promiseSettled = true;
        this.cancelActiveCustom = undefined;
        if (!factorySettled) {
          resolve(pendingValue as Value);
          return;
        }
        try {
          unmount();
          resolve(pendingValue as Value);
        } catch (error) {
          reject(error);
        }
      };
      const close = (value: Value) => {
        if (closed || promiseSettled) return;
        closed = true;
        pendingValue = value;
        hasPendingValue = true;
        complete();
      };
      const fail = (error: unknown) => {
        if (promiseSettled) return;
        closed = true;
        promiseSettled = true;
        this.cancelActiveCustom = undefined;
        try {
          unmount();
          reject(error);
        } catch (cleanupError) {
          reject(cleanupError);
        }
      };
      this.cancelActiveCustom = () => {
        if (promiseSettled) return;
        disposeComponent();
        if (!promiseSettled) fail(new FullscreenUiDisposedError());
      };

      let created: ReturnType<BtwCustomFactory<Value>>;
      try {
        created = factory(fullscreen, this.theme, this.keybindings, close);
      } catch (error) {
        factorySettled = true;
        fail(error);
        return;
      }
      Promise.resolve(created)
        .then((value) => {
          component = value;
          factorySettled = true;
          if (promiseSettled) {
            disposeComponent();
            return;
          }
          if (closed) {
            complete();
            return;
          }
          if (options?.overlay) {
            const overlayOptions =
              typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
            overlay = fullscreen.showOverlay(component, overlayOptions);
            options.onHandle?.(overlay);
          } else {
            fullscreen.clear();
            fullscreen.addChild(component);
            mounted = true;
            fullscreen.setFocus(component);
            fullscreen.requestRender();
          }
        })
        .catch(fail);
    });
  }
}

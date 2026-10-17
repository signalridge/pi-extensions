import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

type NativeTUI = TUI & Pick<TuiAltScreen | TuiMainScreen, "getFocusedComponent">;
function hasNativeFocus(tui: TUI): tui is NativeTUI {
  return "getFocusedComponent" in tui && typeof tui.getFocusedComponent === "function";
}
export interface NativeUI {
  tui: TUI;
  theme: Theme;
  checkDraft(): void;
  checkFocus(): void;
}
/** Headless-safe: only type imports. No root editor replacement, stale paste, or
 * saved-text restoration. The bridge has no long-lived native custom promise.
 */
export async function captureNativeUI(ui: ExtensionUIContext, guard: () => void): Promise<NativeUI> {
  guard();
  const draft = ui.getEditorText();
  let native: NativeUI | undefined;
  let finishBridge: (() => void) | undefined;
  // SDK 1.0.4 custom completion unconditionally pops the last overlay. Use custom
  // ONLY as a synchronous, non-capturing bridge to the public native TUI/theme.
  // Complete in onHandle, before another interaction can interleave. Never hide
  // this custom-created handle directly. Long-lived views use raw showOverlay.
  await ui.custom<void>(
    (tui, theme, _keys, done) => {
      guard();
      if (!hasNativeFocus(tui)) throw new Error("Todo requires native terminal focus inspection");
      const prior = tui.getFocusedComponent();
      const checkDraft = () => {
        if (ui.getEditorText() !== draft) throw new Error("Todo root draft changed; reopen /todo.");
      };
      native = {
        tui,
        theme,
        checkDraft,
        checkFocus() {
          checkDraft();
          if (tui.getFocusedComponent() !== prior) throw new Error("Todo focus owner changed; reopen /todo.");
        },
      };
      finishBridge = done;
      return { render: () => [], invalidate() {} };
    },
    { overlay: true, overlayOptions: { nonCapturing: true }, onHandle: () => finishBridge?.() },
  );
  guard();
  if (!native) throw new Error("Native Todo UI unavailable");
  native.checkFocus();
  return native;
}

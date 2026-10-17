import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type OverlayHandle,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ApprovalOperation } from "@signalridge/pi-approval-core";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Hard-wrap without discarding a separator at a word boundary. Compact views
 * encode preview whitespace/backslashes so data newlines cannot look like soft
 * wrapping, and a literal escape cannot impersonate an encoded separator. */
function wrapReview(source: string, width: number, exactWhitespace: boolean): string[] {
  const lines: string[] = [];
  let line = "";
  let columns = 0;
  const append = (value: string) => {
    for (const { segment } of graphemes.segment(value)) {
      const size = visibleWidth(segment);
      if (columns + size > width && line) {
        lines.push(line);
        line = "";
        columns = 0;
      }
      line += segment;
      columns += size;
    }
  };
  for (const { segment } of graphemes.segment(source)) {
    if (segment === "\n") {
      if (exactWhitespace) append("\\u{a}");
      lines.push(line);
      line = "";
      columns = 0;
      continue;
    }
    const size = visibleWidth(segment);
    // Pi's output layer compatibility-decomposes Thai/Lao AM. Preserve the
    // original source code points instead of approving a normalized lookalike.
    const encodeCluster =
      size === 0 ||
      size > width ||
      /[\u0e33\u0eb3]/u.test(segment) ||
      (exactWhitespace && /\p{White_Space}/u.test(segment));
    append(
      encodeCluster
        ? Array.from(segment, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`).join("")
        : exactWhitespace
          ? segment.replaceAll("\\", "\\\\")
          : segment,
    );
  }
  lines.push(line);
  return lines;
}

interface ReviewComponent extends Component {
  focused: boolean;
  reconcile(): void;
  dispose(): void;
}
export function createReviewComponent(
  tui: TUI,
  operation: ApprovalOperation,
  signal: AbortSignal,
  done: (approved: boolean) => void,
  canComplete: () => boolean = () => true,
): ReviewComponent {
  let offset = 0;
  let height = 1;
  let total = 1;
  let finished = false;
  let focused = false;
  let decision: boolean | undefined;
  const header = "APPROVAL REVIEW";
  const controls = "Ctrl+A approve | Esc deny";
  const scrolling = "Up/Down/PgUp/PgDn/Home/End scroll";
  let layout: { width: number; compact: boolean; source: string; lines: string[] } | undefined;
  const reconcile = () => {
    if (finished || decision === undefined || !canComplete()) return;
    finished = true;
    done(signal.aborted ? false : decision);
  };
  const finish = (value: boolean) => {
    if (finished) return;
    decision = signal.aborted ? false : value;
    reconcile();
    tui.requestRender();
  };
  const abort = () => finish(false);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) queueMicrotask(abort);
  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      if (focused === value) return;
      focused = value;
      tui.requestRender();
      // Native hideOverlay restores focus before its close callback finishes.
      // Complete only afterward, never pop the foreign overlay in that stack operation.
      if (value) queueMicrotask(reconcile);
    },
    reconcile,
    render(width: number) {
      // A native question can take focus without adding an overlay. Do not
      // obscure it with a full-screen review that cannot receive its answer.
      if (!focused || finished) return [];
      width = Math.max(1, width);
      const rows = Math.max(1, tui.terminal.rows);
      const compact = width < 40 || rows < 6;
      if (!layout || layout.width !== width || layout.compact !== compact || layout.source !== operation.preview) {
        const prefix = compact
          ? wrapReview(`${header}\n${controls}\n${scrolling}\nPreview whitespace/backslashes escaped`, width, false)
          : [];
        layout = {
          width,
          compact,
          source: operation.preview,
          lines: [...prefix, ...wrapReview(operation.preview, width, compact)],
        };
      }
      const lines = layout.lines;
      height = compact ? rows : rows - 4;
      total = lines.length;
      offset = Math.min(offset, Math.max(0, total - height));
      const body = lines.slice(offset, offset + height);
      queueMicrotask(reconcile);
      if (compact) return body;
      while (body.length < height) body.push("");
      return [
        header,
        controls,
        ...body,
        scrolling,
        `Lines ${offset + 1}-${Math.min(total, offset + height)}/${total}`,
      ].map((line) => truncateToWidth(line, width, ""));
    },
    handleInput(data: string) {
      if (finished) return;
      if (signal.aborted) finish(false);
      else if (focused && matchesKey(data, "ctrl+a")) finish(true);
      else if (matchesKey(data, "escape")) finish(false);
      else {
        if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
        if (matchesKey(data, "down")) offset += 1;
        if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - Math.max(1, height - 1));
        if (matchesKey(data, "pageDown")) offset += Math.max(1, height - 1);
        if (matchesKey(data, "home")) offset = 0;
        if (matchesKey(data, "end")) offset = Math.max(0, total - height);
        tui.requestRender();
      }
    },
    invalidate() {},
    dispose() {
      finished = true;
      signal.removeEventListener("abort", abort);
    },
  };
}
/** Human command only. Borrow the public TUI synchronously, then own an
 * identity-addressed overlay, never a long-lived native pop-last callback. */
export async function confirmOperation(
  ctx: ExtensionContext,
  operation: ApprovalOperation,
  signal: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || signal.aborted) return false;
  if (ctx.mode === "rpc")
    return ctx.ui.confirm("Approve exactly this operation?", operation.preview, { signal, timeout: 60_000 });
  if (ctx.mode !== "tui") return false;
  let tui: TUI | undefined;
  let finishBridge: (() => void) | undefined;
  await ctx.ui.custom<void>(
    (host, _theme, _keys, done) => {
      tui = host;
      finishBridge = done;
      return { render: () => [], invalidate() {} };
    },
    // Native done pops the last overlay: complete synchronously only after
    // admission, before any other interaction can interleave. Never touch the
    // editor text, paste map, cursor or Undo history.
    { overlay: true, overlayOptions: { nonCapturing: true }, onHandle: () => finishBridge?.() },
  );
  if (!tui || signal.aborted) return false;
  const host = tui;
  return new Promise<boolean>((resolve, reject) => {
    let handle: OverlayHandle | undefined;
    const component = createReviewComponent(
      host,
      operation,
      signal,
      (approved) => {
        handle?.hide();
        component.dispose();
        resolve(approved);
      },
      () => handle !== undefined && (signal.aborted || handle.isFocused()),
    );
    try {
      handle = host.showOverlay(component, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
      component.reconcile();
    } catch (error) {
      handle?.hide();
      component.dispose();
      reject(error);
    }
  });
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type CommandOwner, isOwnerCurrent, ownedCustom } from "./command-owner.js";
import {
  discoverStatusActions,
  openStatusAction,
  STATUS_ACTION_ERROR,
  type StatusActionDescriptor,
  sameStatusAction,
} from "./status-actions.js";
import { sanitizeTerminalText } from "./terminal.js";

export type StatusReader = () => ReadonlyMap<string, string>;
export function statusDetailText(value: string): string {
  return sanitizeTerminalText(value.slice(0, 16_384)).slice(0, 4_096);
}

/** A read-only inspector: status keys, never row indexes, carry selection identity. */
export async function inspectStatuses(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: CommandOwner,
  readStatuses: StatusReader,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !isOwnerCurrent(owner)) return;
  const sessionId = ctx.sessionManager.getSessionId();
  let selectedAction: StatusActionDescriptor | undefined;
  try {
    selectedAction = await ownedCustom(
      ctx,
      owner,
    )<StatusActionDescriptor | undefined>((tui, theme, keys, done) => {
      let disposed = false;
      let actions: StatusActionDescriptor[] = [];
      let loading = true;
      let selectedKey: string | undefined;
      let initialized = false;
      let detail: string | undefined;
      let detailOffset = 0;
      let pageSize = 6;
      const discovery = new AbortController();
      const current = () => !disposed && isOwnerCurrent(owner);
      const rows = () => {
        if (!current()) return [];
        const result = [...readStatuses()].filter(
          ([key, value]) => typeof key === "string" && typeof value === "string",
        );
        if (!initialized) {
          initialized = true;
          selectedKey = result[0]?.[0];
        }
        if (selectedKey !== undefined && !result.some(([key]) => key === selectedKey)) {
          selectedKey = undefined;
          detail = undefined;
        }
        return result;
      };
      // Establish identity at mount, even if queued input arrives before the
      // first paint. Later reconciliation must never choose a replacement row.
      rows();
      void discoverStatusActions(pi.events, sessionId, discovery.signal, () => isOwnerCurrent(owner)).then((found) => {
        if (!current()) return;
        actions = found;
        loading = false;
        tui.requestRender();
      });
      const clock = setInterval(() => {
        if (disposed) return;
        try {
          if (!current()) {
            done(undefined);
            return;
          }
          rows();
          tui.requestRender();
        } catch {
          done(undefined);
        }
      }, 100);
      return {
        capturesViewportInput: true,
        dispose() {
          if (disposed) return;
          disposed = true;
          clearInterval(clock);
          discovery.abort();
        },
        invalidate() {},
        render(width: number): string[] {
          if (!current() || width < 1) return [];
          const statuses = rows();
          const height = Math.max(1, Math.min(10, tui.terminal.rows - 2));
          pageSize = Math.max(1, height - 2);
          const lines = [theme.fg("accent", truncateToWidth("Extension statuses", width))];
          if (detail !== undefined) {
            const wrapped = wrapTextWithAnsi(detail || "(empty status)", width).map((line) =>
              truncateToWidth(line, width),
            );
            detailOffset = Math.min(detailOffset, Math.max(0, wrapped.length - pageSize));
            lines.push(...wrapped.slice(detailOffset, detailOffset + pageSize));
          } else if (statuses.length === 0) {
            lines.push(theme.fg("muted", truncateToWidth("No extension statuses", width)));
          } else {
            const selectedIndex = statuses.findIndex(([key]) => key === selectedKey);
            const start = Math.max(0, Math.min(selectedIndex - Math.floor(pageSize / 2), statuses.length - pageSize));
            for (const [key, value] of statuses.slice(start, start + pageSize)) {
              const action = actions.find((item) => item.statusKey === key);
              const row = `${key === selectedKey ? "› " : "  "}${statusDetailText(key)} · ${statusDetailText(value)}${action ? ` → ${statusDetailText(action.label)}` : ""}`;
              lines.push(theme.fg(key === selectedKey ? "accent" : "muted", truncateToWidth(row, width)));
            }
          }
          const hint =
            detail !== undefined
              ? "↑↓ scroll · Esc close"
              : loading
                ? "Discovering details · Esc close"
                : "↑↓ select · Enter details · Esc close";
          lines.push(theme.fg("dim", truncateToWidth(hint, width)));
          return lines.slice(0, height);
        },
        handleInput(data: string) {
          if (!current() || isKeyRelease(data)) return;
          const statuses = rows(); // Reconcile before Enter, even without an intervening render.
          const bindings = [
            ["tui.select.cancel", "cancel", Key.escape],
            ["tui.select.confirm", "confirm", Key.enter],
            ["tui.select.up", "up", Key.up],
            ["tui.select.down", "down", Key.down],
            ["tui.select.pageUp", "pageUp", Key.pageUp],
            ["tui.select.pageDown", "pageDown", Key.pageDown],
          ] as const;
          // Resolve every configured action before applying any fixed fallback.
          const action =
            bindings.find(([binding]) => keys.matches(data, binding))?.[1] ??
            bindings.find(([, , fallback]) => matchesKey(data, fallback))?.[1];
          if (action === "cancel") {
            done(undefined);
            return;
          }
          const up = action === "up";
          const down = action === "down";
          const pageUp = action === "pageUp";
          const pageDown = action === "pageDown";
          if (up || down || pageUp || pageDown) {
            const delta = up ? -1 : down ? 1 : pageUp ? -pageSize : pageSize;
            if (detail !== undefined) detailOffset = Math.max(0, detailOffset + delta);
            else if (statuses.length > 0) {
              const index = statuses.findIndex(([key]) => key === selectedKey);
              selectedKey =
                statuses[
                  index < 0
                    ? delta < 0
                      ? statuses.length - 1
                      : 0
                    : (index + (delta % statuses.length) + statuses.length) % statuses.length
                ]?.[0];
            }
          } else if (action === "confirm") {
            if (loading || detail !== undefined || selectedKey === undefined) return;
            const row = statuses.find(([key]) => key === selectedKey);
            if (!row) return;
            const action = actions.find((item) => item.statusKey === selectedKey);
            if (action) done(action);
            else {
              detail = `${statusDetailText(row[0])} · ${statusDetailText(row[1])}`;
              detailOffset = 0;
            }
          }
          if (current()) tui.requestRender();
        },
      };
    });
    // ownedCustom awaits unmount/disposal (including a delayed async mount).
    if (!selectedAction || !isOwnerCurrent(owner) || !readStatuses().has(selectedAction.statusKey)) return;
    const selected = selectedAction;
    const fresh = await discoverStatusActions(pi.events, sessionId, owner.signal, () => isOwnerCurrent(owner));
    if (
      !isOwnerCurrent(owner) ||
      !readStatuses().has(selected.statusKey) ||
      !fresh.some((action) => sameStatusAction(action, selected))
    )
      return;
    const accepted = await openStatusAction(pi.events, selected, owner.signal, () => isOwnerCurrent(owner));
    if (!accepted && isOwnerCurrent(owner)) ctx.ui.notify(STATUS_ACTION_ERROR, "warning");
  } catch {
    if (isOwnerCurrent(owner)) ctx.ui.notify(STATUS_ACTION_ERROR, "warning");
  }
}

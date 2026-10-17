// Acceptance-only: native CLI routing and public post-composition frame APIs.
import { appendFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { Owner } from "../src/ownership.js";
import { HumanUI } from "../src/ui.js";

export default function fixture(pi: ExtensionAPI): void {
  const path = process.env.SESSIONS_UI_PROBE;
  if (!path) throw new Error("Missing UI acceptance probe destination");
  let previous = "";
  const record = (data: object) => {
    const serialized = JSON.stringify(data);
    if (serialized === previous) return;
    previous = serialized;
    appendFileSync(path, `${serialized}\n`);
  };
  let active: TuiMainScreen | TuiAltScreen | undefined;
  let stage = "idle";
  const timer = setInterval(() => {
    if (!active?.hasOverlay()) return;
    record({
      event: "frame",
      stage,
      width: active.terminal.columns,
      rows: active.terminal.rows,
      hardwareCursor: active.getShowHardwareCursor(),
      lines:
        active instanceof TuiMainScreen
          ? active.captureRenderState().previousLines.slice(-active.terminal.rows)
          : active.getScreenLines(),
    });
  }, 40);
  timer.unref();
  pi.on("session_shutdown", () => clearInterval(timer));
  const faux = fauxProvider({ provider: "sessions-ui-faux", models: [{ id: "acceptance" }] });
  pi.registerProvider(faux.provider);
  pi.on("session_start", () => record({ event: "ready" }));
  const instrument = (ctx: ExtensionCommandContext): ExtensionCommandContext => {
    const custom: ExtensionUIContext["custom"] = (factory, options) =>
      ctx.ui.custom((tui, theme, keys, done) => {
        if (tui instanceof TuiMainScreen || tui instanceof TuiAltScreen) active = tui;
        // Deliberately synchronous: the production sentinel factory must complete
        // before native custom mounts anything. Never patch the host or renderer.
        return factory(tui, theme, keys, done);
      }, options);
    return { ...ctx, ui: { ...ctx.ui, custom } };
  };
  pi.registerCommand("ui-acceptance", {
    description: "Acceptance-only sessions UI exercise",
    handler: async (args, ctx) => {
      stage = args;
      const owner = new Owner(instrument(ctx), false);
      const ui = new HumanUI(owner);
      const prefill = Array.from({ length: 35 }, (_, i) => `line-${String(i).padStart(2, "0")} 中文`).join("\n");
      try {
        const value =
          args === "exact"
            ? await ui.editor("Review exact whitespace", "    return value\n")
            : args === "insert"
              ? await ui.editor("Review cursor and Undo", "abcd")
              : args === "picker-cursor"
                ? await ui.pick(async (publish) => {
                    const rows = ["XYabcd", "XaYbcd"].map((name, i) => ({
                      id: `cursor-${i}`,
                      path: `/session/cursor-${i}`,
                      name,
                      cwd: "/workspace",
                      modified: "2026",
                      messageCount: 1,
                    }));
                    publish(rows, 2, 2, true);
                    return rows;
                  })
                : args === "editor"
                  ? await ui.editor(
                      "Review summary and all next steps before approving this handoff. ".repeat(3),
                      prefill,
                    )
                  : args === "picker"
                    ? await ui.pick(async (publish) => {
                        const rows = Array.from({ length: 40 }, (_, i) => ({
                          id: `id-${i}`,
                          path: `/session/${i}`,
                          name: `session-${i}`,
                          cwd: "/workspace",
                          modified: "2026",
                          messageCount: 1,
                        }));
                        publish(rows, 40, 40, true);
                        return rows;
                      })
                    : await ui.confirm("Confirm", `${prefill}\nEND OF PREVIEW`);
        record({ event: "result", stage, value });
      } finally {
        owner.finish();
        stage = "idle";
      }
    },
  });
}

// Acceptance-only instrumentation. The real CLI owns editor/focus/shortcut routing.
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import background from "../src/extension.js";

export default function fixture(pi: ExtensionAPI): void {
  const path = process.env.BACKGROUND_SHORTCUT_PROBE;
  if (!path) throw new Error("Missing acceptance probe destination");
  const record = (data: object) => appendFileSync(path, `${JSON.stringify(data)}\n`);
  let serial = 0;
  const instrument = (ctx: ExtensionContext): ExtensionContext => {
    const custom = <T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keys: KeybindingsManager,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      options?: Parameters<ExtensionUIContext["custom"]>[1],
    ): Promise<T> => {
      const id = ++serial;
      record({ event: "open", id, draft: ctx.ui.getEditorText() });
      return ctx.ui
        .custom<T>(async (tui, theme, keys, done) => {
          const component = await factory(tui, theme, keys, done);
          const render = component.render.bind(component);
          component.render = (width) => {
            const lines = render(width);
            record({ event: "frame", id, width, rows: tui.terminal.rows, lines: lines.map(stripTerminalSequences) });
            return lines;
          };
          return component;
        }, options)
        .finally(() => record({ event: "close", id, draft: ctx.ui.getEditorText() }));
    };
    return { ...ctx, ui: { ...ctx.ui, custom } };
  };
  background({
    ...pi,
    registerShortcut: (key, shortcut) =>
      pi.registerShortcut(key, {
        ...shortcut,
        handler: (ctx) => shortcut.handler(instrument(ctx)),
      }),
    registerCommand: (name, command) =>
      pi.registerCommand(name, {
        ...command,
        handler: (args, ctx) => command.handler(args, { ...ctx, ...instrument(ctx) }),
      }),
  });
  const faux = fauxProvider({ provider: "background-shortcut-faux", models: [{ id: "acceptance" }] });
  pi.registerProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("bash_background", {
          command: "printf 'first-log\\n'; sleep 60",
          description: "first",
          notify: "off",
        }),
        fauxToolCall("bash_background", {
          command: "printf 'second-log\\n'; sleep 60",
          description: "second",
          notify: "off",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Independent work complete."),
  ]);
  pi.on("session_start", (_event, ctx) => record({ event: "ready", session: ctx.sessionManager.getSessionId() }));
  pi.on("agent_start", () => record({ event: "agent-start" }));
  pi.on("agent_settled", () => record({ event: "settled" }));
  pi.registerCommand("probe-other", {
    description: "Acceptance: another native dialog",
    handler: async (_args, ctx) => {
      record({ event: "other-open" });
      await ctx.ui.confirm("Other dialog", "Keep focus here");
      record({ event: "other-close" });
    },
  });
  pi.registerCommand("probe-overlay", {
    description: "Acceptance: another extension overlay",
    handler: async (_args, ctx) => {
      record({ event: "overlay-open" });
      await ctx.ui.custom(
        (_tui, _theme, _keys, done) => ({
          render: () => ["Other overlay"],
          invalidate: () => {},
          handleInput: (data) => {
            record({ event: "overlay-key", data });
            if (matchesKey(data, "escape")) done(undefined);
          },
        }),
        { overlay: true },
      );
      record({ event: "overlay-close" });
    },
  });
  pi.registerCommand("probe-retire", {
    description: "Acceptance: committed navigation while the viewer is open",
    handler: async (_args, ctx) => {
      // A single scheduled external navigation, not a polling process or product timer.
      setTimeout(() => {
        void ctx.newSession().then((result) => record({ event: "retired", cancelled: result.cancelled }));
      }, 700);
      record({ event: "retire-armed" });
    },
  });
  pi.registerShortcut("ctrl+alt+d", {
    description: "Acceptance: inspect native editor without replacing it",
    handler: (ctx) => record({ event: "draft", draft: ctx.ui.getEditorText() }),
  });
}

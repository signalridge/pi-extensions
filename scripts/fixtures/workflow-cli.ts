// Acceptance only: public API/context adapters delegate to the actual native host.
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import subagents from "../../packages/pi-subagents/src/index.js";
import { parseWorkflowUiSnapshot, WORKFLOW_UI_CHANNELS } from "../../packages/pi-subagents-protocol/src/index.js";
import workflows from "../../packages/pi-workflows/src/index.js";

export default function fixture(pi: ExtensionAPI): void {
  const destination = process.env.WORKFLOW_CLI_PROBE;
  if (!destination) throw new Error("Missing acceptance probe");
  const record = (data: object) => appendFileSync(destination, `${JSON.stringify(data)}\n`);
  let host: TUI | undefined;
  let serial = 0;
  const widgets = new Map<string, { id: number; placement: string; lines: string[]; width: number; rows: number }>();
  const instrument = <C extends ExtensionContext>(ctx: C): C => {
    const setWidget = (
      key: string,
      content: string[] | Parameters<ExtensionUIContext["setWidget"]>[1],
      options?: Parameters<ExtensionUIContext["setWidget"]>[2],
    ) => {
      widgets.delete(key);
      if (!content) return ctx.ui.setWidget(key, undefined, options);
      const id = ++serial;
      ctx.ui.setWidget(
        key,
        (tui, theme) => {
          host = tui;
          const component = typeof content === "function" ? content(tui, theme) : new Text(content.join("\n"), 0, 0);
          const render = component.render.bind(component);
          component.render = (width) => {
            const ansi = render(width);
            const frame = {
              id,
              placement: options?.placement ?? "aboveEditor",
              lines: ansi.map(stripTerminalSequences),
              width,
              rows: tui.terminal.rows,
            };
            widgets.set(key, frame);
            record({ event: "widget-frame", key, ...frame, ansi, columns: ansi.map(visibleWidth) });
            return ansi;
          };
          return component;
        },
        options,
      );
    };
    const custom = <T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keys: KeybindingsManager,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      options?: Parameters<ExtensionUIContext["custom"]>[1],
    ): Promise<T> => {
      record({ event: "open", draft: ctx.ui.getEditorText() });
      return ctx.ui
        .custom<T>(async (tui, theme, keys, done) => {
          const component = await factory(tui, theme, keys, done);
          const render = component.render.bind(component);
          component.render = (width) => {
            const ansi = render(width);
            record({
              event: "inspector-frame",
              width,
              rows: tui.terminal.rows,
              lines: ansi.map(stripTerminalSequences),
              columns: ansi.map(visibleWidth),
            });
            return ansi;
          };
          return component;
        }, options)
        .finally(() => record({ event: "close", draft: ctx.ui.getEditorText() }));
    };
    return { ...ctx, ui: { ...ctx.ui, setWidget, custom } };
  };
  // Proxy only the public registration surface; never inspect a runner/host private field.
  const observed = new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "on")
        return (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
          Reflect.apply(target.on, target, [
            name,
            name === "project_trust"
              ? handler
              : (event: unknown, ctx: ExtensionContext) => handler(event, instrument(ctx)),
          ]);
      if (key === "registerCommand")
        return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
          target.registerCommand(name, { ...command, handler: (args, ctx) => command.handler(args, instrument(ctx)) });
      return Reflect.get(target, key, receiver);
    },
  });
  for (const name of (process.env.WORKFLOW_CLI_ORDER ?? "workflows,subagents").split(",")) {
    if (name === "workflows") workflows(observed);
    else if (name === "subagents") subagents(observed);
    else throw new Error("Unknown fixture load order");
  }
  pi.events.on(WORKFLOW_UI_CHANNELS.changed, (raw: unknown) => {
    record({ event: "snapshot", snapshot: parseWorkflowUiSnapshot(raw) });
  });
  const owned: string[] = [];
  const faux = fauxProvider({ provider: "workflow-cli-faux", models: [{ id: "offline" }] });
  pi.registerProvider(faux.provider);
  const names = ["CLI_ALPHA_中", "CLI_BETA_é", "CLI_GAMMA_👩‍💻"];
  faux.setResponses([
    fauxAssistantMessage(
      names.map((name, index) =>
        fauxToolCall("workflow", {
          script: `export const meta = { name: ${JSON.stringify(name)}, description: "Offline CLI acceptance", phases: [{ title: "AWAIT_${index}_中" }] }; phase("AWAIT_${index}_中"); await new Promise(() => {});`,
          background: true,
        }),
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("ROOT_FINISHED_BACKGROUND_ONLY"),
    () => {
      if (owned.length !== 3 || new Set(owned).size !== 3) throw new Error("Expected exactly three owned runs");
      return fauxAssistantMessage(
        owned.map((run_id) => fauxToolCall("workflow_control", { action: "stop", run_id })),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("OWNED_RUNS_STOPPED"),
    // Normal background completion delivery can wake the idle parent once.
    fauxAssistantMessage("OWNED_STOP_NOTIFICATION_ACKNOWLEDGED"),
  ]);
  pi.on("tool_execution_end", (event) => {
    record({ event: "tool-end", name: event.toolName, result: event.result, error: event.isError });
    if (event.toolName === "workflow") {
      const details: unknown = event.result.details;
      if (details && typeof details === "object" && "runId" in details && typeof details.runId === "string")
        owned.push(details.runId);
    }
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") throw new Error("Native TUI required");
    record({ event: "ready", cwd: ctx.cwd, session: ctx.sessionManager.getSessionId(), settings: pi.getSettings() });
  });
  pi.on("agent_settled", (_event, ctx) =>
    record({ event: "settled", idle: ctx.isIdle(), calls: faux.state.callCount, owned }),
  );
  pi.on("session_shutdown", (event) => record({ event: "shutdown", reason: event.reason }));
  pi.registerShortcut("ctrl+alt+d", {
    description: "Acceptance: capture live widgets and request native redraw",
    handler: (ctx) => {
      record({
        event: "capture",
        widgets: Object.fromEntries(widgets),
        draft: ctx.ui.getEditorText(),
        idle: ctx.isIdle(),
        calls: faux.state.callCount,
      });
      host?.requestRender(true);
    },
  });
  pi.registerCommand("acceptance-exit", {
    description: "Acceptance: graceful native exit",
    handler: async (_args, ctx) => ctx.shutdown(),
  });
}

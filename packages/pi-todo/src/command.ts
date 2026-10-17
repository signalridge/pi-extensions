import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureNativeUI } from "./native-ui.js";
import type { TodoScreen } from "./screen.js";
import { type Params, transition } from "./state.js";
import type { TodoStore } from "./store.js";

export class TodoCommand {
  private controller?: AbortController;
  constructor(
    private readonly store: TodoStore,
    private readonly updateStatus: (ctx: ExtensionCommandContext) => void,
  ) {}
  retire() {
    this.controller?.abort();
    this.controller = undefined;
  }
  async run(ctx: ExtensionCommandContext) {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify(
        "/todo is a terminal view. Use the todo tool: list, then add/update/remove/clear with baseRevision. No changes made.",
        "info",
      );
      return;
    }
    this.retire();
    const controller = new AbortController();
    this.controller = controller;
    const isOpen = () => {
      if (controller.signal.aborted) throw new Error("Todo view retired");
    };
    let selectedId: string | undefined;
    try {
      isOpen();
      let lease = this.store.lease(ctx);
      let revision = this.store.read(ctx).revision;
      const assertLease = () => {
        isOpen();
        this.store.assert(ctx, lease);
        if (this.store.read(ctx).revision !== revision) throw new Error("Todo revision changed; reopen /todo.");
      };
      const native = await captureNativeUI(ctx.ui, assertLease);
      assertLease();
      native.checkFocus();
      // Terminal-only modules stay out of headless paths.
      const { TodoScreen } = await import("./screen.js");
      assertLease();
      native.checkFocus();
      const { ownedUI, TaskForm, StatusForm } = await import("./ui.js");
      assertLease();
      native.checkFocus();
      while (!controller.signal.aborted) {
        lease = this.store.lease(ctx);
        const snapshot = this.store.read(ctx);
        revision = snapshot.revision;
        // Native ownership checks only: safe to poll while a modal is pending.
        // Full guard/read still verifies persistence at interaction boundaries.
        const currentOwner = () => {
          isOpen();
          this.store.assert(ctx, lease);
          native.checkDraft();
        };
        const guard = () => {
          assertLease();
          native.checkDraft();
        };
        let screen: TodoScreen | undefined;
        const action = await ownedUI<Parameters<TodoScreen["close"]>[0]>(
          native,
          controller.signal,
          guard,
          currentOwner,
          (tui, theme, close) => {
            screen = new TodoScreen(tui, theme, snapshot, selectedId, close);
            return screen;
          },
        );
        guard();
        selectedId = screen?.selectedId;
        if (!action) break;
        try {
          let params: Params;
          const task = snapshot.tasks.find((task) => task.id === action.id);
          if (action.action !== "add" && action.action !== "clear" && !task)
            throw new Error("Selected task no longer exists");
          if (action.action === "add" || action.action === "edit") {
            const fieldsToParams = (fields: { title: string; description?: string; dependencies: string[] }): Params =>
              action.action === "add"
                ? { action: "add", baseRevision: snapshot.revision, ...fields }
                : { action: "update", baseRevision: snapshot.revision, updates: [{ id: task?.id ?? "", ...fields }] };
            const draft = await ownedUI<Params>(
              native,
              controller.signal,
              guard,
              currentOwner,
              (tui, theme, close, ownsFocus) => {
                const form = new TaskForm(
                  tui,
                  theme,
                  task,
                  (fields) => {
                    try {
                      guard();
                      if (!ownsFocus()) throw new Error("Todo form does not own focus");
                      const candidate = fieldsToParams(fields);
                      // Validate without committing or closing: dependency graph errors retain every field.
                      transition(snapshot, candidate);
                      close(candidate);
                    } catch (error) {
                      try {
                        guard();
                        form.fail(String(error));
                      } catch {
                        controller.abort();
                      }
                    }
                  },
                  () => close(),
                );
                return form;
              },
            );
            guard();
            if (!draft) continue;
            params = draft;
          } else if (action.action === "status") {
            const status = await ownedUI<string>(
              native,
              controller.signal,
              guard,
              currentOwner,
              (tui, _theme, close) => new StatusForm(tui, task?.status ?? "pending", close),
            );
            guard();
            if (status === undefined) continue;
            if (status !== "pending" && status !== "in_progress" && status !== "completed")
              throw new Error("Invalid task status choice");
            params = {
              action: "update",
              baseRevision: snapshot.revision,
              updates: [{ id: task?.id ?? "", status }],
            };
          } else if (action.action === "remove")
            params = { action: "remove", baseRevision: snapshot.revision, id: task?.id ?? "" };
          else if (action.action === "clear") params = { action: "clear", baseRevision: snapshot.revision };
          else throw new Error("Invalid todo action");
          guard();
          const result = this.store.mutate(ctx, params, lease);
          if (action.action === "add") selectedId = result.tasks.at(-1)?.id;
          this.updateStatus(ctx);
        } catch (error) {
          guard();
          ctx.ui.notify(String(error), "error");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) ctx.ui.notify(String(error), "error");
    } finally {
      if (this.controller === controller) this.retire();
    }
  }
}

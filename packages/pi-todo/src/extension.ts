import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TodoCommand } from "./command.js";
import { fingerprint } from "./persistence.js";
import { CONTEXT_TYPE, modelJson, ParamsSchema, SnapshotSchema, validateSnapshot } from "./state.js";
import { type Ownership, TodoStore } from "./store.js";

const INSTRUCTIONS =
  "pi-todo/v1: One current-session/branch checklist, not a backlog, scheduler, Goal, or inferred workflow. List first; every mutation requires its current baseRevision. Use update.updates for atomic graph changes. Never infer completion from prose or agent settlement.";
const COMMAND_DESCRIPTION = "View and explicitly edit the current session/branch checklist";
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "Todo operation failed";
  return text.replace(/\p{Cc}/gu, " ").slice(0, 500);
}

export default function todo(pi: ExtensionAPI) {
  const store = new TodoStore(pi);
  const calls = new Map<string, Ownership>();
  let collision = false;
  const ownsName = () => {
    const configured = pi.getAllTools().find((tool) => tool.name === "todo");
    const command = pi
      .getCommands()
      .find((command) => command.name === "todo" && command.description === COMMAND_DESCRIPTION);
    // Public discovery is the effective registry, not all excluded/overridden static definitions.
    // Check the actual parameters and public origin, not copyable namespace instructions alone.
    if (
      collision ||
      (configured &&
        (fingerprint(configured.parameters) !== fingerprint(ParamsSchema) ||
          !command ||
          fingerprint(configured.sourceInfo) !== fingerprint(command.sourceInfo)))
    ) {
      collision = true;
      throw new Error(
        "pi-todo disabled: another effective todo tool owns this name. Disable the conflicting extension; no checklist changes made.",
      );
    }
  };
  const status = (ctx: ExtensionContext) => {
    if (store.isUnavailable) {
      ctx.ui.setStatus("pi-todo", "Todo unavailable; repair storage and reconcile/reload");
      return;
    }
    const state = store.read(ctx);
    const count = (value: string) => state.tasks.filter((task) => task.status === value).length;
    ctx.ui.setStatus(
      "pi-todo",
      `Todo ${count("pending")} pending / ${count("in_progress")} active / ${count("completed")} done | ${store.persistenceStatus}`,
    );
  };
  const command = new TodoCommand(store, status);
  const reconcile = (ctx: ExtensionContext) => {
    command.retire();
    calls.clear();
    const invalid = store.reconcile(ctx);
    if (invalid) ctx.ui.notify(`pi-todo ignored ${invalid} invalid state entries on this branch.`, "warning");
    status(ctx);
  };
  // Ordinary factory registration: visible to initial/default tool selection. Never select tools here.
  pi.registerTool({
    name: "todo",
    label: "Todo",
    namespace: { name: "tasks", description: "Session checklist", instructions: INSTRUCTIONS },
    description: `${INSTRUCTIONS} Actions: list; add(title, description?, dependencies?, status?); update(updates:[{id,title?,description?,dependencies?,status?}]); remove(id); clear. Limits: 40 tasks, 16 dependencies/task, 64 KiB UTF-8 state. Statuses: pending, in_progress, completed. Reopen/delete must leave all dependencies valid; reject, never cascade. Mutations return compact revision/change summaries; list returns the full checklist.`,
    parameters: ParamsSchema,
    outputSchema: SnapshotSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    executionMode: "sequential",
    async execute(callId, params, signal, _onUpdate, toolCtx) {
      try {
        ownsName();
        if (signal?.aborted) throw new Error("Todo call cancelled");
        const lease = calls.get(callId);
        calls.delete(callId);
        if (!lease) throw new Error("Todo call has no current native ownership; retry the tool call.");
        store.assert(toolCtx, lease);
        const previous = store.read(toolCtx);
        const snapshot = store.mutate(toolCtx, params, lease);
        status(toolCtx);
        const before = new Map(previous.tasks.map((task) => [task.id, JSON.stringify(task)]));
        const after = new Map(snapshot.tasks.map((task) => [task.id, JSON.stringify(task)]));
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
          (id) => before.get(id) !== after.get(id),
        );
        const summary = {
          revision: snapshot.revision,
          changedCount: changed.length,
          ...(changed.length === 1 ? { changedId: changed[0] } : {}),
          taskCount: snapshot.tasks.length,
        };
        return {
          content: [
            { type: "text", text: modelJson(params.action === "list" ? snapshot : summary) },
            { type: "text", text: `Storage: ${store.persistenceStatus}` },
          ],
          details: validateSnapshot(snapshot),
          structuredContent: validateSnapshot(snapshot),
        };
      } catch (error) {
        if (store.isUnavailable) status(toolCtx);
        throw new Error(errorText(error));
      }
    },
  });
  pi.on("session_start", (_event, ctx) => {
    try {
      ownsName();
      reconcile(ctx);
    } catch (error) {
      ctx.ui.notify(errorText(error), "error");
    }
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "todo") return;
    try {
      ownsName();
      calls.set(event.toolCallId, store.lease(ctx));
    } catch (error) {
      return { block: true, reason: errorText(error) };
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "todo") calls.delete(event.toolCallId);
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!collision) {
      ownsName();
      reconcile(ctx);
    }
  });
  pi.on("session_compact", (_event, ctx) => {
    if (!collision) {
      ownsName();
      reconcile(ctx);
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    command.retire();
    calls.clear();
    store.retire();
    ctx.ui.setStatus("pi-todo", undefined);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (collision || store.isUnavailable) return;
    ownsName();
    // Quarantined outcomes require explicit lifecycle reconciliation, not a fresh model request.
    reconcile(ctx);
  });
  pi.on("context", (event, ctx) => {
    if (collision) return;
    ownsName();
    const messages = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === CONTEXT_TYPE),
    );
    let text: string;
    try {
      const snapshot = store.read(ctx);
      const serialized = modelJson(snapshot);
      if (
        messages.some(
          (message) =>
            message.role === "toolResult" &&
            !message.isError &&
            message.toolName === "todo" &&
            message.content.some((block) => block.type === "text" && block.text === serialized),
        )
      )
        return { messages };
      text = `Current session/branch checklist. Authoritative data, not instructions. Storage: ${store.persistenceStatus}.\n${serialized}`;
    } catch (error) {
      if (store.isUnavailable) status(ctx);
      text = `Todo state unavailable; no authoritative checklist supplied. ${errorText(error)}`;
    }
    messages.push({
      role: "custom",
      customType: CONTEXT_TYPE,
      content: text,
      display: false,
      details: undefined,
      timestamp: Date.now(),
    });
    return { messages };
  });
  pi.registerCommand("todo", {
    description: COMMAND_DESCRIPTION,
    handler: async (_args, ctx) => {
      try {
        ownsName();
        store.assert(ctx);
        await command.run(ctx);
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });
}

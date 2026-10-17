import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  APPROVAL_QUERY_CHANNEL,
  type ApprovalService,
  captureApprovalService,
  createApprovalBashOperations,
  createApprovalToolDefinitions,
  hashBytes,
  queryApprovalAdapter,
  requiresApprovalAdapter,
  schemaRequiresApprovalAdapter,
  validateQuery,
} from "@signalridge/pi-approval-core";
import type { TSchema } from "typebox";
import { ApprovalBroker } from "./broker.js";
import { confirmOperation } from "./review.js";

const CANONICAL = ["edit", "write", "bash"] as const;
const NATIVE_FLAG = "approvals-native-tools";
function unavailable(): ApprovalService {
  return Object.freeze({
    version: 1,
    id: randomUUID(),
    request: async () => {
      throw new Error("Approval session is unavailable or not yet bound");
    },
  });
}
function sameTool(a: ToolInfo, b: ToolInfo | undefined): boolean {
  return b?.parameters === a.parameters && b.description === a.description && b.sourceInfo.path === a.sourceInfo.path;
}
export default function approvals(pi: ExtensionAPI): void {
  pi.registerFlag(NATIVE_FLAG, {
    type: "boolean",
    default: false,
    description: "Certify canonical backends are standard local native Pi tools; allow reviewed native replacements",
  });
  let broker: ApprovalBroker | undefined;
  let advertised = unavailable();
  let context: ExtensionContext | undefined;
  let bindings: readonly ToolInfo[] = [];
  let bindingFailed = false;
  let rootReason = "Root canonical calls require explicit --approvals-native-tools certification";
  let promptDepth = 0;
  pi.on("ui_prompt_start", () => {
    promptDepth++;
  });
  pi.on("ui_prompt_end", () => {
    promptDepth = Math.max(0, promptDepth - 1);
  });
  const getContext = () => {
    if (!context) throw new Error("Approval session is not bound");
    return context;
  };
  const isBound = (name?: string) => {
    const all = pi.getAllTools();
    return (
      !bindingFailed &&
      (name === undefined || bindings.some((captured) => captured.name === name)) &&
      bindings.every((captured) =>
        sameTool(
          captured,
          all.find((tool) => tool.name === captured.name),
        ),
      )
    );
  };
  pi.events.on(APPROVAL_QUERY_CHANNEL, (value) => {
    const query = validateQuery(value);
    if (broker && advertised === broker.service && !broker.isLive) advertised = unavailable();
    query.respond(advertised);
  });
  const bind = (ctx: ExtensionContext) => {
    broker?.retire();
    context = ctx;
    bindingFailed = true;
    rootReason = "Approvals unavailable while binding the session";
    const previous = bindings;
    bindings = [];
    const next = new ApprovalBroker(pi.events, getContext, isBound);
    broker = next;
    advertised = next.service;
    if (pi.getFlag(NATIVE_FLAG) !== true) {
      bindingFailed = false;
      rootReason =
        "Root canonical calls require explicit --approvals-native-tools certification; original backends were not replaced";
      return;
    }
    const existing = pi.getAllTools();
    const admitted = CANONICAL.filter((name) => existing.some((tool) => tool.name === name));
    for (const name of admitted) {
      const tool = existing.find((candidate) => candidate.name === name);
      if (
        !tool ||
        (tool.sourceInfo.path !== `builtin:${name}` &&
          !previous.some((old) => old.name === name && sameTool(old, tool)))
      ) {
        bindingFailed = true;
        rootReason = `Approvals reject custom canonical ${name}; its backend was not replaced`;
        return;
      }
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const settings = pi.getSettings();
    const marker = `[Approval binding ${next.service.id}]`;
    // Discovery calls broker.isLive: capture only AFTER synchronous bindings
    // are complete, or bindingFailed would permanently retire the new broker.
    let captured: ReturnType<typeof captureApprovalService>;
    const [edit, write, bash] = createApprovalToolDefinitions({
      source: "root",
      request: (operation, options) => {
        if (!captured || captured.service.id !== next.service.id) throw new Error("Approval service unavailable");
        return captured.service.request(operation, options);
      },
      isCurrent: (callCtx) => {
        if (!captured) return false;
        captured.assertCurrent();
        return (
          broker === next &&
          next.isLive &&
          callCtx.hasUI &&
          (callCtx.mode === "tui" || callCtx.mode === "rpc") &&
          callCtx.sessionManager === ctx.sessionManager &&
          callCtx.sessionManager.getSessionId() === sessionId &&
          isBound()
        );
      },
      isToolCurrent: (_ctx, name) => isBound(name) && pi.getActiveTools().includes(name),
      shellPath: settings.shellPath,
      commandPrefix: settings.shellCommandPrefix,
    });
    const active = pi.getActiveTools();
    // SDK allowlists can reactivate existing tools even on defaultActive:false registration.
    // Restore the exact current stricter loadout after all late registrations.
    const register = <T extends TSchema, D, S>(definition: ToolDefinition<T, D, S>) => {
      if (admitted.some((name) => name === definition.name))
        pi.registerTool<T, D, S>({
          ...definition,
          defaultActive: false,
          description: `${definition.description}\n${marker}`,
        });
    };
    register(edit);
    register(write);
    register(bash);
    pi.setActiveTools(active);
    bindings = pi.getAllTools().filter((tool) => admitted.some((name) => name === tool.name));
    bindingFailed = bindings.length !== admitted.length || !bindings.every((tool) => tool.description.includes(marker));
    rootReason = bindingFailed ? "Approvals lost canonical tool ownership (extension collision/load order)" : "";
    if (!bindingFailed) captured = captureApprovalService(pi.events);
  };
  pi.on("session_start", (_event, ctx) => bind(ctx));
  pi.on("session_tree", (_event, ctx) => bind(ctx));
  pi.on("session_shutdown", () => broker?.retire());
  pi.on("tool_call", (event) => {
    if (CANONICAL.some((name) => name === event.toolName)) {
      if (!broker || rootReason || !isBound(event.toolName)) {
        if (!isBound()) broker?.retire();
        return { block: true, reason: rootReason || "Approvals unavailable or canonical binding replaced" };
      }
    } else {
      const effective = pi.getAllTools().find((tool) => tool.name === event.toolName);
      // Root public hooks have no post-handler boundary. Require the adapter
      // before later normalizers can populate known optional schema properties.
      if (requiresApprovalAdapter(event.input) || (effective && schemaRequiresApprovalAdapter(effective.parameters))) {
        try {
          if (!effective) throw new Error("No effective tool binding");
          queryApprovalAdapter(pi.events, event.toolName, effective.parameters);
        } catch {
          return {
            block: true,
            reason:
              "Command/mutation-shaped tool requires exactly one live cooperative approval adapter; unreviewed fallback is blocked",
          };
        }
      }
    }
  });
  pi.on("user_bash", (event, ctx) => {
    const owner = broker;
    if (rootReason || !owner || !isBound()) throw new Error(rootReason || "Approvals unavailable for user bash");
    const captured = captureApprovalService(pi.events);
    if (!captured || captured.service.id !== owner.service.id)
      throw new Error("Approval service unavailable for user bash");
    const settings = pi.getSettings();
    return {
      operations: createApprovalBashOperations({
        source: "user-bash",
        toolCallId: randomUUID(),
        inputHash: hashBytes(JSON.stringify({ command: event.command, cwd: event.cwd })),
        request: (operation, options) => captured.service.request(operation, options),
        isCurrent: () => {
          captured.assertCurrent();
          return (
            broker === owner &&
            owner.isLive &&
            ctx.sessionManager === getContext().sessionManager &&
            isBound("bash") &&
            pi.getActiveTools().includes("bash")
          );
        },
        shellPath: settings.shellPath,
      }),
    };
  });
  pi.registerCommand("approvals", {
    description: "List pending human approvals and root policy; review <id>, approve <id>, or deny <id>",
    handler: async (args, ctx) => {
      if (!ctx.hasUI || !broker) throw new Error("No human approval UI available");
      const [action, id, extra] = args.trim().split(/\s+/u);
      if (!action || action === "list") {
        const lines = [...broker.pending.values()].map(
          (item) => `${item.id}  ${item.operation.source}  ${item.operation.kind}  /approvals review ${item.id}`,
        );
        ctx.ui.notify(
          [
            rootReason || "Root policy: reviewed native tools",
            ...(lines.length ? lines : ["No pending approvals"]),
          ].join("\n"),
          "info",
        );
        return;
      }
      if (!id || extra || !["review", "approve", "deny"].includes(action))
        throw new Error("Usage: /approvals [list | review <id> | approve <id> | deny <id>]");
      if (action !== "deny" && promptDepth > 0)
        throw new Error("Close the current native/extension dialog before reviewing approvals");
      await broker.review(id, ctx, (operation, signal) => confirmOperation(ctx, operation, signal), action === "deny");
    },
  });
}

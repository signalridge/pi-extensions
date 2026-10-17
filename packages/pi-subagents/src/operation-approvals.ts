import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionContext, type ExtensionToolContext, type SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ApprovalService, createApprovalToolDefinitions } from "@signalridge/pi-approval-core";
import { captureQuestionOrigin } from "./question-origin.js";

/** Human service capture and native context leases live for the entire child session. */
export function createChildApprovalTools(options: {
  service: ApprovalService;
  assertServiceCurrent: () => void;
  root: ExtensionContext;
  rootOrigin: (current: ExtensionContext) => boolean;
  agentId?: string;
  settings: SettingsManager;
  waiting: (toolCallId: string) => () => void;
  isBound: () => boolean;
  isToolCurrent: (name: string) => boolean;
}): ToolDefinition[] {
  const leases = new WeakMap<ExtensionToolContext, () => boolean>();
  const [edit, write, bash] = createApprovalToolDefinitions({
    source: `child:${options.agentId ?? randomUUID()}`,
    shellPath: options.settings.getShellPath(),
    commandPrefix: options.settings.getShellCommandPrefix(),
    isToolCurrent: (_ctx, name) => options.isToolCurrent(name),
    isCurrent: (ctx) => {
      let lease = leases.get(ctx);
      if (!lease) {
        const childOrigin = captureQuestionOrigin(ctx);
        const invocationRoot = captureQuestionOrigin(options.root);
        lease = () => {
          if (ctx.signal?.aborted || !options.isBound() || !options.rootOrigin(options.root) ||
            !invocationRoot(options.root) || !childOrigin(ctx)) return false;
          options.assertServiceCurrent();
          return true;
        };
        leases.set(ctx, lease);
      }
      return lease();
    },
    request: async (operation, owner) => {
      const resume = options.waiting(operation.toolCallId);
      try {
        await options.service.request(operation, owner);
      } finally {
        resume();
      }
    },
  });
  return [defineTool(edit), defineTool(write), defineTool(bash)];
}

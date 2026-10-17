import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hashBytes, queryApprovalService, validateOperation } from "@signalridge/pi-approval-core";

/** Test-only trusted human command: creates a second held request, never executes a command. */
export default function hold(pi: ExtensionAPI): void {
  pi.registerCommand("approval-test-hold", {
    description: "Hold a separate test approval without executing anything",
    handler: async (_args, ctx) => {
      const service = queryApprovalService(pi.events);
      if (!service) throw new Error("Missing test approval service");
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        await service.request(
          validateOperation({
            kind: "command",
            source: "rpc-test",
            toolName: "bash",
            toolCallId: randomUUID(),
            cwd: ctx.cwd,
            command: "true",
            preview: "true",
            inputHash: hashBytes("true"),
          }),
          { isCurrent: () => ctx.sessionManager.getSessionId() === sessionId },
        );
      } catch {
        /* A human denial is the expected end of this held test request. */
      }
    },
  });
}

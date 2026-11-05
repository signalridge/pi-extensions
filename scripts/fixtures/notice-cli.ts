// Copied by the harness into a disposable generated package, never installed.
import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function noticeFixture(pi: ExtensionAPI): void {
  const path = process.env.WORKFLOW_CLI_PROBE;
  if (!path) throw new Error("Missing acceptance probe");
  const record = (data: object) => appendFileSync(path, `${JSON.stringify(data)}\n`);
  const faux = fauxProvider({ provider: "notice-cli-faux", models: [{ id: "offline" }] });
  faux.setResponses([fauxAssistantMessage("NOTICE_SESSION_PERSISTED")]);
  pi.registerProvider(faux.provider);
  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") throw new Error("Native TUI required");
    record({ event: "ready", reason: event.reason, session: ctx.sessionManager.getSessionFile() });
  });
  pi.on("agent_settled", () => record({ event: "settled", calls: faux.state.callCount }));
  pi.on("session_shutdown", () => record({ event: "shutdown" }));
  pi.registerCommand("acceptance-exit", {
    description: "Acceptance: graceful native exit",
    handler: async (_args, ctx) => ctx.shutdown(),
  });
}

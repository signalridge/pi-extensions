// Acceptance-only: real CLI /todo routing, no SDK patch or model request.
import { appendFileSync } from "node:fs";
import { fauxProvider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import todo from "../src/extension.js";
import { type Snapshot, STATE_TYPE, validateSnapshot } from "../src/state.js";

export default function fixture(pi: ExtensionAPI): void {
  if (VERSION !== "1.0.4") throw new Error(`CLI proof requires Pi 1.0.4, got ${VERSION}`);
  const path = process.env.PI_TODO_CLI_EVIDENCE;
  if (!path) throw new Error("Missing CLI evidence destination");
  const record = (event: string, data: object) => appendFileSync(path, `${JSON.stringify({ event, ...data })}\n`);
  let turns = 0;
  const initial: Snapshot = validateSnapshot({
    schemaVersion: 1,
    revision: 2,
    tasks: [
      { id: "00000000-0000-4000-8000-000000000001", title: "Prerequisite", dependencies: [], status: "completed" },
      {
        id: "00000000-0000-4000-8000-000000000002",
        title: "中文 abcd",
        description: "Keep 中文 description",
        dependencies: ["00000000-0000-4000-8000-000000000001"],
        status: "pending",
      },
    ],
  });
  const faux = fauxProvider({ provider: "todo-prefill-faux", models: [{ id: "acceptance" }] });
  pi.registerProvider(faux.provider);
  // Seed public extension state before Todo reconstructs it on session_start.
  pi.on("session_start", () => pi.appendEntry(STATE_TYPE, initial));
  todo(pi);
  pi.on("agent_start", () => {
    turns++;
  });
  pi.on("session_start", () => record("ready", { initial, sdk: VERSION }));
  pi.registerCommand("todo-proof-result", {
    description: "Acceptance-only snapshot capture and orderly exit",
    handler: async (_args, ctx) => {
      const entry = [...ctx.sessionManager.getBranch()]
        .reverse()
        .find((item) => item.type === "custom" && item.customType === STATE_TYPE);
      if (entry?.type !== "custom") throw new Error("Missing Todo snapshot");
      record("result", { snapshot: validateSnapshot(entry.data), turns });
      ctx.shutdown();
    },
  });
}

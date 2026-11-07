import {
  createSupervisorTool,
  type SupervisorAsk,
  type SupervisorToolContext,
} from "../packages/pi-subagents/src/supervisor.js";

// Compile old source-level imports and fresh object literals without restoring
// any child-to-human dialog. These optional compatibility fields are ignored.
const ask: SupervisorAsk = {
  input: async (_title, _placeholder) => undefined,
  select: async (_title, _options) => undefined,
};
const legacy: SupervisorToolContext = { agentLabel: "Implement", ask };
createSupervisorTool(legacy);
createSupervisorTool({ agentLabel: "Implement", ask });
createSupervisorTool({ parentQuestion: async () => ({ status: "unanswered", reason: "declined" }) });

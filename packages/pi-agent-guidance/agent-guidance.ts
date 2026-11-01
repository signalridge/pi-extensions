/**
 * agent-guidance - Provider-specific and subdirectory context loading
 *
 * Loads CLAUDE.md, CODEX.md, or GEMINI.md based on current model provider,
 * supplementing Pi Core's AGENTS.md loading, and delivers context files from
 * directories below the working directory when the agent first touches them.
 *
 * Deduplication uses the host's actual context files, by resolved path or content.
 */

import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyProviderContext } from "./provider-context.js";
import { loadConfig } from "./selection.js";
import { createSubdirectoryContext } from "./subdirectory-context.js";

export default function agentGuidance(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const config = loadConfig(agentDir);
  const subdirectories = createSubdirectoryContext(pi, config, agentDir);

  pi.on("before_agent_start", async (event, ctx) => {
    const { loaded, result } = applyProviderContext(event, ctx, config, agentDir);
    subdirectories.observe(loaded);
    return result;
  });
  pi.on("turn_start", () => subdirectories.startTurn());
  pi.on("tool_result", (event, ctx) => subdirectories.onToolResult(event, ctx));
}

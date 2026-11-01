import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  createSecretsSession,
  formatStatus,
  obfuscateRequest,
  restoreToolInput,
  type SecretsSession,
} from "./session.js";

export const SECRETS_COMMAND = "secrets";

/** Static, so the system prompt stays byte-stable whether or not a secret has been seen. */
export const PLACEHOLDER_GUIDELINE =
  "Text shaped like $$LABEL_HASH$$ (an uppercase label and a 12-character code between double dollar signs) stands for a redacted secret. Copy it verbatim into tool arguments when the real value is needed; Pi substitutes the value just before the tool runs. Do not try to decode it or ask for the value.";

export interface SecretsExtensionOptions {
  /** Environment to scan; defaults to `process.env` at session start. */
  env?: () => Readonly<Record<string, string | undefined>>;
  /** Directory for the user configuration and placeholder key; defaults to Pi's agent directory. */
  agentDir?: () => string;
}

function projectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    // A replaced session can invalidate its UI; notifications are advisory.
  }
}

/** Register the secret obfuscation hooks, with environment/agent-dir seams for tests. */
export function registerSecrets(pi: ExtensionAPI, options: SecretsExtensionOptions = {}): void {
  let session: SecretsSession | undefined;

  const open = (ctx: ExtensionContext): SecretsSession => {
    session = createSecretsSession({
      env: options.env?.() ?? process.env,
      agentDir: options.agentDir?.() ?? getAgentDir(),
      projectConfigDir: join(ctx.cwd, CONFIG_DIR_NAME),
      projectTrusted: projectTrusted(ctx),
    });
    return session;
  };

  pi.on("session_start", (_event, ctx) => {
    const opened = open(ctx);
    const problems = opened.config.warnings.length + (opened.key.persistent ? 0 : 1);
    if (problems > 0)
      notify(ctx, `pi-secrets: ${problems} configuration problem(s); run /${SECRETS_COMMAND}`, "warning");
  });

  pi.on("session_shutdown", () => {
    session = undefined;
  });

  pi.on("before_agent_start", (event) => {
    const guidelines = event.systemPromptOptions.promptGuidelines;
    if (!guidelines.includes(PLACEHOLDER_GUIDELINE)) guidelines.push(PLACEHOLDER_GUIDELINE);
  });

  // `context_with_system` runs after every `context` handler, whatever the load
  // order, and returning it unchanged keeps Pi's system-message layout. System
  // messages (prompt and tool declarations) are deliberately left alone.
  pi.on("context_with_system", (event, ctx) => {
    const current = session ?? open(ctx);
    try {
      const result = obfuscateRequest(current, event.messages);
      return result.changed ? { messages: result.messages } : undefined;
    } catch {
      // Fail closed: never let an unredacted transcript reach the provider.
      current.stats.failures += 1;
      try {
        ctx.abort();
      } catch {
        // The request below carries no conversation either way.
      }
      notify(ctx, "pi-secrets could not rewrite the request; it was withheld.", "error");
      return {
        messages: event.messages.filter((message) => message.role === "system"),
      };
    }
  });

  // Pi validated and cloned the arguments; mutating `event.input` changes only
  // what executes, never the stored assistant message.
  pi.on("tool_call", (event, ctx) => {
    restoreToolInput(session ?? open(ctx), event.input);
  });

  pi.registerCommand(SECRETS_COMMAND, {
    description: "Show how many secrets are obfuscated (counts only, never values)",
    handler: async (_args, ctx) => {
      notify(ctx, formatStatus(session), "info");
    },
  });
}

export default function secrets(pi: ExtensionAPI): void {
  registerSecrets(pi);
}

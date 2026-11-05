/** Cold-reopen catalog-route fence, not credential/issuer or physical-endpoint consent. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export interface AgentReopenRoute {
  provider: string;
  api: string;
  modelId: string;
  baseUrl: string;
}

const RECOVERY = "Start a fresh Agent with inherit_context: false and an explicitly sanitized task summary.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Only the SDK's public built-in catalog establishes a nonsecret endpoint.
 * URL syntax cannot prove that a path is credential-free. Require an exact
 * provider/API/model/endpoint match, conservatively excluding custom model IDs
 * even on a known endpoint. Never use the configured runtime catalog as proof.
 */
export function parseReopenRoute(value: unknown): AgentReopenRoute | undefined {
  if (!record(value)) return undefined;
  const { provider, api, modelId, baseUrl } = value;
  if (typeof provider !== "string" || !/^[\w.-]{1,128}$/.test(provider) ||
    typeof api !== "string" || !/^[\w.:-]{1,128}$/.test(api) || api === "pi-virtual" ||
    typeof modelId !== "string" || !/^[\w.:/@-]{1,256}$/.test(modelId) ||
    typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 2_000) return undefined;
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
  } catch { return undefined; }
  const builtinProvider = getBuiltinProviders().find(id => id === provider);
  if (!builtinProvider) return undefined;
  const builtin = getBuiltinModels(builtinProvider).find(model => model.provider === provider &&
    model.id === modelId && model.api === api && model.baseUrl === baseUrl);
  if (!builtin) return undefined;
  return { provider, api, modelId, baseUrl: builtin.baseUrl };
}

/** Model's public spelling is baseUrl (not baseURL); virtual selections prove no physical route. */
export function captureReopenRoute(model: Model<Api> | undefined): AgentReopenRoute | undefined {
  return model ? parseReopenRoute({ provider: model.provider, api: model.api, modelId: model.id, baseUrl: model.baseUrl }) : undefined;
}

export function sameReopenRoute(left: AgentReopenRoute | undefined, right: AgentReopenRoute | undefined): boolean {
  return !!left && !!right && left.provider === right.provider && left.api === right.api &&
    left.modelId === right.modelId && left.baseUrl === right.baseUrl;
}

/** Call before lease/allocation, again at queued admission, and before native prompt. */
export function assertReopenRoute(saved: AgentReopenRoute | undefined, model: Model<Api> | undefined): void {
  if (!sameReopenRoute(parseReopenRoute(saved), captureReopenRoute(model))) {
    throw new Error(`Saved agent route proof is missing, unknown, or changed (provider/API/model/baseUrl); only public SDK built-in catalog routes qualify. No history was dispatched. ${RECOVERY}`);
  }
}

/**
 * No public issuer/profile proof accompanies native signatures. Matching provider/model
 * (even endpoint) does NOT qualify cross-profile or cross-issuer opaque replay. Inspect
 * the un-compacted journal too: edits/compaction must not hide unqualified history.
 */
export function assertPlainReopenHistory(manager: Pick<SessionManager, "getEntries">, route: AgentReopenRoute): void {
  const checkContent = (content: unknown): void => {
    if (typeof content === "string" || content === undefined) return;
    if (!Array.isArray(content) || content.some(block => !record(block) ||
      !["text", "thinking", "toolCall", "image"].includes(String(block.type)) ||
      block.textSignature !== undefined || block.thinkingSignature !== undefined ||
      block.thoughtSignature !== undefined || block.redacted === true)) {
      throw new Error(`Saved child contains opaque or unknown replay content; public metadata cannot prove compatible issuer/profile replay. ${RECOVERY}`);
    }
  };
  for (const entry of manager.getEntries()) {
    if (entry.type === "message") {
      if ("content" in entry.message) checkContent(entry.message.content);
      if (entry.message.role === "assistant") {
        const message = entry.message;
        if (message.deferred !== undefined) throw new Error(`Saved child contains an opaque deferred handle without issuer/profile replay proof. ${RECOVERY}`);
        if (message.provider !== route.provider || message.api !== route.api || message.model !== route.modelId) {
          throw new Error(`Saved child history has a different or unknown provider/API/model route. ${RECOVERY}`);
        }
      }
    } else if (entry.type === "model_change") {
      if (entry.provider !== route.provider || entry.modelId !== route.modelId) {
        throw new Error(`Saved child history changed model route. ${RECOVERY}`);
      }
    } else if (entry.type === "custom_message") {
      checkContent(entry.content);
    } else if (entry.type === "context_edit") {
      checkContent(entry.replacement?.content);
    } else if (entry.type === "compaction") {
      // SDK 1.5 CompactionEntry.summary is a string, not an assistant message.
      // systemMessage is separate replayable state; details is non-model metadata.
      if (typeof entry.summary !== "string") throw new Error(`Saved child has unknown compaction replay content. ${RECOVERY}`);
      checkContent(entry.systemMessage?.content);
    } else if (entry.type === "branch_summary" && typeof entry.summary !== "string") {
      throw new Error(`Saved child has unknown branch-summary replay content. ${RECOVERY}`);
    }
  }
}

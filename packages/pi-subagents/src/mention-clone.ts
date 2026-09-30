/**
 * mention-clone.ts — start a mentioned agent through a hidden, mention-only
 * session without putting anything in the chat.
 *
 * Claude Code routes `@agent-<type>` through the main model: the mention
 * becomes a `<system-reminder>` appended to the prompt and the model makes the
 * tool call (see `agentMentionReminder`). That buys the spawned agent a prompt
 * written with conversation context, and costs a visible turn — the model's
 * reasoning and its tool block land in the transcript, for a decision the user
 * already made when they typed the handle.
 *
 * So the turn happens somewhere else. A throwaway in-memory session takes it
 * off-screen on the parent's model, but receives only this mention's text.
 * Pi's public ExtensionContext exposes a pre-hook SessionManager projection,
 * not the parent's request-local context hooks (including programmatic hooks).
 * Copying even a compacted or edited branch could send private parent content
 * to the clone's provider before its redaction runs. The clone must start empty:
 * no parent branch, system prompt, tool declarations, or summaries.
 *
 * Its `thinkingLevel` is NOT used, and is the one place the newer API would be
 * better. `getSessionContextSettings` starts at "off" and moves only on an
 * explicit `thinking_level_change` entry, so a session where nobody ran
 * `/think` reports "off" rather than the level it is really using. Omitting the
 * field instead lets `createAgentSession` resolve it from settings, which is
 * that real level.
 *
 * Three details make the spawn belong to the real session rather than the
 * clone:
 *
 *   - the clone is handed the *registered* `Agent` tool, whose handler closes
 *     over the main activation, so it spawns top-level: widget, fleet row,
 *     handle, completion notification, all as if the main model had called it;
 *   - that tool is re-bound to the main `ExtensionContext`, because the handler
 *     reads `cwd`, `model` and `sessionManager.getSessionId()` off it to place
 *     the transcript and the `rootSessionId`. The clone's own context would
 *     file both under the throwaway fork;
 *   - it is called with no tool-call id. The clone's turn produces one, but the
 *     real session never issued it, and a `<tool-use-id>` pointing at nothing
 *     is exactly the bug the mention-resume path had to fix;
 *   - and it is forced into the background. A foreground agent returns its
 *     answer as the tool result and is marked `resultConsumed` so no completion
 *     notification is sent — correct when the caller is the real conversation,
 *     silent loss when the caller is a fork about to be discarded. Background
 *     delivery is the only route from a mention back to the main model.
 *
 * The clone gets one tool and one job. It cannot read, write or run anything —
 * an invisible turn with the full toolset could do invisible work.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "./child-context.js";
import { parentModelSessionOptions } from "./model-runtime-bridge.js";
import type { SubagentType, ThinkingLevel } from "./types.js";

const MENTION_SYSTEM_PROMPT =
  "You write a task prompt for the Agent tool using only the user's current message. " +
  "Call Agent once to start the requested task. You have no prior conversation context; " +
  "do not invent or request inherited context. If details are missing, pass the user's words through.";

/** Internal acknowledgement: the real Agent handler has returned from manager.spawn. */
export const MENTION_SPAWNED = Symbol("pi-subagents:mention-spawned");

export interface MentionCloneOptions {
  /** The MAIN session's context — what the spawn is attributed to, not a
   * source of provider history or instructions for the hidden turn. */
  ctx: ExtensionContext;
  /** Agent type the handle resolved to. */
  type: SubagentType;
  /** What the user typed after the handle. */
  message: string;
  /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
  agentTool: ToolDefinition;
  /** False once the originating session or branch has been replaced. */
  isOriginCurrent: () => boolean;
}

export interface MentionCloneResult {
  /** True once the registered Agent handler confirmed a child was started. */
  spawned: boolean;
  /** The Agent handler ran but refused the spawn; direct fallback must not bypass its policy. */
  refused?: boolean;
  /** Why not, when it didn't. Absent on success. */
  error?: string;
}

/**
 * Let a mention-only throwaway session make the tool call, then discard it.
 * Never rejects: a clone that cannot run is reported so the caller can fall
 * back to starting the agent directly.
 */
export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool, isOriginCurrent } = opts;

  let spawned = false;
  let refused = false;
  let attempted = false;
  const cloneAgentTool: ToolDefinition = {
    ...agentTool,
    execute: async (_cloneToolCallId, params, signal, onUpdate, _cloneCtx) => {
      // The model may ask for another type or a schedule, but the user chose
      // exactly one agent by typing its handle. Never let the hidden turn widen
      // that decision or attempt another spawn after a failed call.
      if (attempted) {
        return {
          content: [{ type: "text" as const, text: "Already attempted an agent for this mention. Stop here." }],
          details: undefined,
          isError: true,
        };
      }
      attempted = true;
      if (!isOriginCurrent()) {
        return {
          content: [{ type: "text" as const, text: "The original session changed. Do not start this agent." }],
          details: undefined,
          isError: true,
        };
      }
      const choice = params as Record<string, unknown>;
      const selected = {
        subagent_type: type,
        prompt: typeof choice.prompt === "string" && choice.prompt.trim() ? choice.prompt : message,
        ...(typeof choice.description === "string" && { description: choice.description }),
        run_in_background: true,
        // The handler acknowledges immediately after manager.spawn returns,
        // before UI/event side effects can throw. A tool result alone cannot
        // distinguish a pre-spawn rejection from a post-spawn exception.
        [MENTION_SPAWNED]: () => { spawned = true; },
      } as typeof params;
      // A foreground result would be delivered only into the discarded clone.
      // Attribute the background spawn to the real session, with no dangling
      // tool-call id. A plain text rejection is not a successful spawn.
      // Pi 0.99 tool handlers require a tool context, not the event-handler
      // context captured from the parent. Keep every session-bound field from
      // the parent, and supply the real clone call's nested-tool capabilities;
      // Agent itself does not use those capabilities. Never pretend the parent
      // has executeTool(), which only exists during an actual tool invocation.
      const mainToolCtx = { ...ctx, tools: _cloneCtx.tools, executeTool: _cloneCtx.executeTool };
      const result = await agentTool.execute(undefined as never, selected, signal, onUpdate, mainToolCtx);
      const details = result.details as { agentId?: unknown; status?: unknown } | undefined;
      spawned ||= typeof details?.agentId === "string" &&
        (details.status === "background" || details.status === "queued");
      refused = !spawned;
      return result;
    },
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    // Refuse before loading or prompting when a modern host cannot bridge the
    // parent's providers/virtual routes into this throwaway session.
    // The hidden clone inherits exactly this model; unlike an explicit child
    // selection, a stale parent model cannot be replaced before its request.
    const parentModels = parentModelSessionOptions(ctx, ctx.model);
    // An empty manager works on both old Pi hosts (which read agent state) and
    // new ones (which project the manager). Never inspect the parent's branch:
    // its pre-hook content cannot safely seed a separate provider request.
    const cloneManager = SessionManager.inMemory(ctx.cwd);
    // Pi 0.82.0 added this; below it the field is absent and the clone takes
    // the settings level instead, which is what a session that never ran
    // `/think` is on anyway. Same shim shape as `modelRuntime` below.
    const thinkingLevel = (ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel;
    // No project or inline extensions run in the hidden session. The parent's
    // programmatic context hooks cannot be enumerated from ExtensionContext,
    // so replaying only file-backed hooks would be an unsafe partial policy.
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => MENTION_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    const created = await runInChildSessionContext(async () => {
      await loader.reload();
      return createAgentSession({
        cwd: ctx.cwd,
        // Nothing about the copy is worth persisting, and an in-memory manager
        // is also what keeps the real session untouched.
        sessionManager: cloneManager,
        resourceLoader: loader,
        model: ctx.model as Model<never> | undefined,
        ...(thinkingLevel && { thinkingLevel }),
        ...parentModels,
        // An allowlist naming exactly the clone's own tool. NOT `noTools:
        // "all"`, whose doc comment ("start with no tools enabled") reads like
        // it spares custom tools and does not: it resolves to an EMPTY
        // allowlist, and `isAllowedTool` then drops every tool from the
        // registry — the custom one included. The clone would be prompted with
        // nothing to call, answer in prose, and every mention would fall
        // through to the direct start with a warning. Same idiom as
        // agent-runner's `tools: sessionTools` beside its nested `customTools`.
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      } as Parameters<typeof createAgentSession>[0]);
    });
    session = created.session;
    // Loading resources and creating the session both yield. If the parent was
    // replaced during either step, never make a provider request for a stale
    // mention. The tool-level check below still fences a switch during streaming.
    if (!isOriginCurrent()) return { spawned: false, error: "the original session changed" };

    // A session switch during a slow provider stream may produce no tool call
    // for minutes. The tool fence below prevents a stale spawn, but without
    // cancelling the clone that hidden request keeps running after its parent
    // is gone. Check while the prompt is pending and abort the throwaway turn.
    const clone = session;
    let abortRequested = false;
    const staleCheck = setInterval(() => {
      if (abortRequested || isOriginCurrent()) return;
      abortRequested = true;
      void clone.abort().catch(() => {});
    }, 100);
    try {
      // Only the current mention text reaches the hidden provider request.
      // The selected type is enforced by the Agent wrapper, not extra history.
      await clone.prompt(message);
    } finally {
      clearInterval(staleCheck);
    }
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  return spawned
    ? { spawned: true }
    : refused
      ? { spawned: false, refused: true, error: "the Agent tool refused this mention" }
      : { spawned: false, error: "the conversation clone did not start it" };
}

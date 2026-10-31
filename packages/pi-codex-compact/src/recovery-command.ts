import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getSystemMessageText, type Model, type Tool } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease } from "@earendil-works/pi-tui";
import {
  buildReplacementHistory,
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
} from "./checkpoint.js";
import { createDiagnosticTrace, diagnosticSummary } from "./diagnostics.js";
import { compactionAbortError, compactionError, failureFrom, formatCompactionFailure } from "./failure.js";
import { exportRecoverySession } from "./recovery-export.js";
import { splitRecoveryContext } from "./recovery-snapshot.js";
import { requestRemoteCompaction } from "./remote.js";
import { type CodexCompactSettingsRuntime, effectiveStageTimeoutMs } from "./settings.js";
import { sameTools } from "./tool-state.js";

interface RecoveryDependencies {
  project(
    branch: SessionEntry[],
    model: Model<"openai-codex-responses">,
  ): {
    messages: AgentMessage[];
    transcript: AgentMessage[];
    prior?: CodexCheckpointDetails;
  };
  matches(transcript: AgentMessage[], ctx: ExtensionContext): boolean;
  tools(): Tool[];
  authenticate(
    ctx: ExtensionContext,
    model: Model<"openai-codex-responses">,
    signal: AbortSignal,
    deadline: number,
  ): ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>;
  payloadValidator(ctx: ExtensionContext): ((payload: unknown) => boolean) | undefined;
  fetch?: typeof globalThis.fetch;
}

function fileIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported recovery source file");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function safeText(text: string): string {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
      ? " "
      : character;
  }).join("");
}
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "warning"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    /* A late UI failure cannot undo a published export. */
  }
}

/** One cancellable explicit idle owner, separate from ordinary/full compaction. */
export function createRecoveryCommand(
  pi: ExtensionAPI,
  runtime: CodexCompactSettingsRuntime,
  dependencies: RecoveryDependencies,
) {
  let owner: AbortController | undefined;
  let pending:
    | {
        nonce: string;
        expiresAt: number;
        matches(ctx: ExtensionCommandContext): boolean;
        execute(): Promise<void>;
      }
    | undefined;
  const cancel = () => {
    pending = undefined;
    const previous = owner;
    owner = undefined;
    previous?.abort();
  };
  const noRequest = (ctx: ExtensionCommandContext) => {
    if (ctx.mode === "tui" && ctx.hasUI)
      notify(
        ctx,
        "Recovery confirmation unavailable or expired; no request was sent. Offer recovery again from /codex-compact.",
      );
  };
  return {
    cancel,
    async handle(args: string, ctx: ExtensionCommandContext): Promise<boolean> {
      if (!args) return false;
      if (args === "cancel-recovery") {
        cancel();
        return true;
      }
      const ticket = pending;
      if (
        !ticket ||
        args !== `confirm-recovery ${ticket.nonce}` ||
        Date.now() >= ticket.expiresAt ||
        !ticket.matches(ctx)
      ) {
        if (ticket && (Date.now() >= ticket.expiresAt || !ticket.matches(ctx))) cancel();
        noRequest(ctx);
        return true;
      }
      // Consume synchronously before the first await: even concurrent SDK commands
      // cannot spend a human's one-operation canonical-history grant twice.
      pending = undefined;
      await ticket.execute();
      return true;
    },
    async run(ctx: ExtensionCommandContext, sessionSignal: AbortSignal): Promise<void> {
      if (ctx.mode !== "tui" || !ctx.hasUI || sessionSignal.aborted) return;
      if (owner || !ctx.isIdle() || ctx.hasPendingMessages()) {
        notify(ctx, "Recovery export requires an idle session with no pending work or other recovery export.");
        return;
      }
      const controller = new AbortController();
      owner = controller;
      const signal = AbortSignal.any([controller.signal, sessionSignal]);
      // No generic ctx.abort fence: only the extension-owned recovery signal.
      let isCurrent = (): boolean => false;
      let timedOut = false;
      let offered = false;
      try {
        const manager = ctx.sessionManager;
        const ui = ctx.ui;
        const registry = ctx.modelRegistry;
        const onTerminalInput = ui.onTerminalInput;
        const setWidget = ui.setWidget;
        const ownsUI = () => {
          try {
            return (
              ctx.mode === "tui" &&
              ctx.hasUI &&
              ctx.ui === ui &&
              ui.onTerminalInput === onTerminalInput &&
              ui.setWidget === setWidget
            );
          } catch {
            return false;
          }
        };
        if (typeof onTerminalInput !== "function" || typeof setWidget !== "function") {
          if (ownsUI())
            notify(ctx, "Recovery export unavailable; scoped terminal input and disposable widgets are required.");
          return;
        }
        const sessionId = manager.getSessionId();
        const ownerIsCurrent = () => {
          try {
            return (
              !signal.aborted && ownsUI() && ctx.sessionManager === manager && manager.getSessionId() === sessionId
            );
          } catch {
            return false;
          }
        };
        isCurrent = ownerIsCurrent;
        const settings = structuredClone(runtime.get().settings);
        const stageTimeoutMs = effectiveStageTimeoutMs(settings);
        const model = ctx.model;
        if (!settings.enabled || model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
          throw compactionError("checkpoint_incompatible");
        }
        const sourceModel = structuredClone(model);
        // Both supported SDKs return a stable public Provider object. Pin it AND
        // implementations: in-place same-route replacement must also fence work.
        const provider = registry.getProvider(model.provider);
        if (!provider) throw compactionError("provider_unavailable");
        const stream = provider.stream;
        const streamSimple = provider.streamSimple;
        const providerId = provider.id;
        const providerBaseUrl = provider.baseUrl;
        const providerHeaders = provider.headers;
        const headerProfile =
          typeof providerHeaders === "function" ? providerHeaders : structuredClone(providerHeaders);
        const auth = provider.auth;
        const apiKeyAuth = auth.apiKey;
        const oauth = auth.oauth;
        const resolve = apiKeyAuth?.resolve;
        const refresh = oauth?.refresh;
        const toAuth = oauth?.toAuth;
        const login = oauth?.login;
        const getApiKeyAndHeaders = registry.getApiKeyAndHeaders;
        const sourceFile = manager.getSessionFile();
        const sessionDir = manager.getSessionDir();
        if (!sourceFile || !isAbsolute(sourceFile) || !isAbsolute(sessionDir))
          throw new Error("Recovery needs a persisted source");
        const diskIdentity = fileIdentity(sourceFile);
        const branch = structuredClone(manager.getBranch());
        const branchKey = JSON.stringify(branch);
        const leafId = manager.getLeafId();
        if (
          !leafId ||
          branch.at(-1)?.id !== leafId ||
          new Set(branch.map((entry) => entry.id)).size !== branch.length ||
          branch.some((entry, index) => !entry.id || entry.parentId !== (branch[index - 1]?.id ?? null))
        ) {
          throw new Error("Recovery source lineage is invalid");
        }
        const effectiveSettings = pi.getSettings();
        const settingsKey = JSON.stringify(effectiveSettings);
        const trusted = ctx.isProjectTrusted();
        // Public, read-only effective settings snapshot includes host overrides
        // and trust scoping; never parse/reload or persist another settings file.
        const settingsView = SettingsManager.inMemory(effectiveSettings, { projectTrusted: trusted });
        const keepRecentTokens = settingsView.getCompactionKeepRecentTokens(model);
        const current = dependencies.project(branch, model);
        const prior = current.prior;
        if (!prior) throw compactionError("checkpoint_projection_failed");
        const head = current.messages[0];
        if (head?.role !== "system" || current.messages.filter((message) => message.role === "system").length !== 1) {
          throw compactionError("checkpoint_projection_failed");
        }
        // Lease both offer-time views. The cloned branch/head pins canonical
        // content; the shared matcher's equal-view shortcut must not authorize
        // C/E becoming C/C while confirmation, auth, body or publication waits.
        const canonicalPrompt = getSystemMessageText(head);
        const effectivePrompt = ctx.getSystemPrompt();
        // Cold-load eligibility failure is actionable, not a stale takeover.
        if (!dependencies.matches(current.transcript, ctx)) throw compactionError("loadout_mismatch");
        // Freeze the validator against this offered branch and prompt pair,
        // never recompute it after auth from a newly equal current view.
        const validatePayload = dependencies.payloadValidator(ctx);
        const split = splitRecoveryContext(current.messages.slice(1), prior.checkpointId, keepRecentTokens);
        const tools = structuredClone(dependencies.tools());
        let retired = false;
        isCurrent = () => {
          if (retired) return false;
          try {
            retired =
              !ownerIsCurrent() ||
              !ctx.isIdle() ||
              ctx.hasPendingMessages() ||
              !isDeepStrictEqual(ctx.model, sourceModel) ||
              ctx.modelRegistry !== registry ||
              registry.getApiKeyAndHeaders !== getApiKeyAndHeaders ||
              registry.getProvider(model.provider) !== provider ||
              provider.stream !== stream ||
              provider.streamSimple !== streamSimple ||
              provider.id !== providerId ||
              provider.baseUrl !== providerBaseUrl ||
              provider.headers !== providerHeaders ||
              !isDeepStrictEqual(provider.headers, headerProfile) ||
              provider.auth !== auth ||
              auth.apiKey !== apiKeyAuth ||
              auth.oauth !== oauth ||
              apiKeyAuth?.resolve !== resolve ||
              oauth?.refresh !== refresh ||
              oauth?.toAuth !== toAuth ||
              oauth?.login !== login ||
              manager.getSessionFile() !== sourceFile ||
              manager.getSessionDir() !== sessionDir ||
              manager.getLeafId() !== leafId ||
              JSON.stringify(manager.getBranch()) !== branchKey ||
              fileIdentity(sourceFile) !== diskIdentity ||
              ctx.isProjectTrusted() !== trusted ||
              JSON.stringify(pi.getSettings()) !== settingsKey ||
              JSON.stringify(runtime.get().settings) !== JSON.stringify(settings) ||
              ctx.getSystemPrompt() !== effectivePrompt ||
              !dependencies.matches(current.transcript, ctx) ||
              !sameTools(tools, dependencies.tools());
          } catch {
            retired = true;
          }
          return !retired;
        };
        if (!isCurrent()) throw compactionAbortError();
        const nonce = randomUUID();
        const expiresAt = Date.now() + 5 * 60 * 1000;
        // A pending offer owns no dialog, widget, terminal subscription or auth.
        // Expiry is silent and cannot close a newer extension's native selector.
        const expiry = setTimeout(
          () => {
            if (pending?.nonce === nonce) cancel();
          },
          5 * 60 * 1000,
        );
        expiry.unref?.();
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(expiry);
            if (pending?.nonce === nonce) pending = undefined;
            if (owner === controller) owner = undefined;
          },
          { once: true },
        );
        pending = {
          nonce,
          expiresAt,
          matches: (confirmationCtx) => {
            try {
              return (
                confirmationCtx.mode === "tui" &&
                confirmationCtx.hasUI &&
                confirmationCtx.ui === ui &&
                confirmationCtx.sessionManager === manager &&
                confirmationCtx.modelRegistry === registry &&
                isDeepStrictEqual(confirmationCtx.model, sourceModel) &&
                confirmationCtx.getSystemPrompt() === effectivePrompt &&
                isCurrent()
              );
            } catch {
              return false;
            }
          },
          execute: async () => {
            clearTimeout(expiry);
            try {
              const key = `codex-recovery-${randomUUID()}`;
              let retiredProgress = false;
              let unsubscribe: (() => void) | undefined;
              let timeout: ReturnType<typeof setTimeout> | undefined;
              const retire = () => {
                if (retiredProgress) return;
                retiredProgress = true;
                clearTimeout(timeout);
                controller.abort();
                try {
                  unsubscribe?.();
                } catch {
                  /* Only this operation's subscription, never global input. */
                }
                if (ownsUI()) {
                  try {
                    ui.setWidget(key, undefined);
                  } catch {
                    /* Best effort own-key cleanup. */
                  }
                }
              };
              const cancelled = new Promise<void>((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    retire();
                    resolve();
                  },
                  { once: true },
                );
              });
              try {
                unsubscribe = ui.onTerminalInput((data) => {
                  // TUI invokes extension input listeners before filtering Kitty
                  // releases. The Enter release completing nonce submission is
                  // not new input and must not cancel newly authorized work.
                  if (data.length && !isKeyRelease(data)) retire();
                  // Never consume input: an unrelated modal/editor retains its keys.
                  return undefined;
                });
                let mounted = false;
                ui.setWidget(key, () => {
                  mounted = true;
                  return {
                    render: (width) => ["Codex recovery export · Escape/Ctrl+C/new input cancels".slice(0, width)],
                    invalidate() {},
                    dispose: retire,
                  };
                });
                if (!mounted || !isCurrent()) throw compactionAbortError();
                const diagnostics = createDiagnosticTrace(sessionId, "recovery", {
                  signal,
                  operationTimeoutMs: settings.requestTimeoutMs,
                  stageTimeoutMs,
                });
                const work = async () => {
                  if (!isCurrent()) return;
                  const budget = Math.min(settings.requestTimeoutMs, stageTimeoutMs);
                  const deadline = performance.now() + budget;
                  diagnostics.phase("auth");
                  timeout = setTimeout(() => {
                    if (signal.aborted) return; // Earlier user/session cancellation wins.
                    timedOut = true;
                    // Signal cancellation retires progress and resolves the command even
                    // if an auth implementation ignores cancellation indefinitely.
                    diagnostics.finish(
                      "failure",
                      "remote_timeout",
                      settings.requestTimeoutMs <= stageTimeoutMs ? "operation" : "stage",
                    );
                    if (isCurrent())
                      notify(
                        ctx,
                        `Recovery export failed; original unchanged. [remote_timeout] ${diagnosticSummary(diagnostics.snapshot())}`,
                      );
                    controller.abort();
                  }, budget);
                  try {
                    const auth = await dependencies.authenticate(ctx, model, signal, deadline);
                    if (!isCurrent()) throw compactionAbortError();
                    if (!auth.ok || !auth.apiKey) throw compactionError("credentials_unavailable");
                    const remainingMs = deadline - performance.now();
                    if (remainingMs <= 0) throw compactionError("remote_timeout");
                    diagnostics.fold();
                    const response = await requestRemoteCompaction({
                      diagnostics,
                      provider,
                      model: { ...model, baseUrl: auth.baseUrl ?? model.baseUrl },
                      context: {
                        systemPrompt: canonicalPrompt,
                        messages: convertToLlm([head, ...split.prefix]),
                        tools,
                      },
                      apiKey: auth.apiKey,
                      headers: auth.headers,
                      env: auth.env,
                      signal,
                      isCurrent,
                      validatePayload,
                      priorCheckpoint: {
                        marker: checkpointMarker(prior.checkpointId),
                        replacementHistory: prior.replacementHistory,
                      },
                      requestTimeoutMs: remainingMs,
                      maxRetries: 0,
                      fetch: dependencies.fetch,
                    });
                    if (!isCurrent()) throw compactionAbortError();
                    diagnostics.usage(response.usage);
                    diagnostics.phase("fold_done");
                    const details = createCheckpointDetails({
                      modelId: model.id,
                      replacementHistory: buildReplacementHistory(response.promptInput, response.item, {
                        tokenBudget: settings.replacementTokenBudget,
                      }),
                      keptMessages: [],
                    });
                    await exportRecoverySession({
                      cwd: manager.getCwd(),
                      sessionDir,
                      sourceSessionId: sessionId,
                      sourceEntryIds: branch.map((entry) => entry.id),
                      head,
                      details,
                      suffix: split.suffix,
                      usage: response.usage,
                      signal,
                      isCurrent,
                      deadline,
                      onPublished: (result) => {
                        // Publication is committed: cleanup must not extend the deadline
                        // or hold the command/UI hostage to a slow descriptor close.
                        clearTimeout(timeout);
                        diagnostics.finish("exported");
                        try {
                          if (isCurrent())
                            notify(
                              ctx,
                              `Recovery exported to NEW session ${safeText(result.sessionId)} at ${safeText(result.path)}. Original unchanged. Open it explicitly with /resume; no follow-up was sent. This does not prove the next request fits.${result.durabilityConfirmed ? "" : " Directory durability could not be confirmed; the complete export remains available."}`,
                              "info",
                            );
                        } finally {
                          retire();
                        }
                      },
                    });
                  } finally {
                    clearTimeout(timeout);
                  }
                };
                // Observe every late failure; cancellation must retire the progress UI,
                // while publication remains guarded through auth, body, and staging.
                const running = work()
                  .catch((error: unknown) => {
                    const failure = failureFrom(error, "local_compaction_failed");
                    if (isCurrent())
                      diagnostics.finish(
                        "failure",
                        failure.code,
                        failure.code === "remote_timeout" || failure.code === "authentication_timeout"
                          ? settings.requestTimeoutMs <= stageTimeoutMs
                            ? "operation"
                            : "stage"
                          : "none",
                      );
                    if (!timedOut && isCurrent())
                      notify(
                        ctx,
                        `Recovery export failed; original unchanged. ${formatCompactionFailure(failureFrom(error, "local_compaction_failed"))} ${diagnosticSummary(diagnostics.snapshot())}`,
                      );
                  })
                  .finally(retire);
                await Promise.race([running, cancelled]);
                diagnostics.finish("cancelled");
              } finally {
                retire();
              }
            } catch (error) {
              if (isCurrent())
                notify(
                  ctx,
                  `Recovery export unavailable; original unchanged. ${formatCompactionFailure(failureFrom(error, "local_compaction_failed"))}`,
                );
            } finally {
              controller.abort();
              if (owner === controller) owner = undefined;
            }
          },
        };
        offered = true;
        notify(
          ctx,
          `Recovery OFFER ONLY: send ${split.prefix.length} canonical prefix messages (including the prior opaque checkpoint), keeping ${split.suffix.length} complete suffix messages UNSENT. Canonical history includes custom content, system instructions and tools, bypasses request-local filters, and may be retained/replayed; persisted context_edit omissions remain honored. This one prefix request may cost money and may still exceed the backend window. No retries or native fallback. Your original session and backups remain unchanged. Success creates a NEW session, not an in-place repair. Copied historical assistant/tool usage and cost are reset to zero; original accounting stays in the source, and only this recovery call is charged to the new checkpoint. No switch or follow-up send occurs. Settings do not change, including allowCanonicalHistory. To authorize canonical history ONCE within five minutes, run exactly:\n/codex-compact confirm-recovery ${nonce}\nOtherwise do not confirm, or run /codex-compact cancel-recovery. Any ordinary input or session/model change discards this offer.`,
          "info",
        );
      } catch (error) {
        if (isCurrent())
          notify(
            ctx,
            `Recovery export unavailable; original unchanged. ${formatCompactionFailure(failureFrom(error, "checkpoint_projection_failed"))}`,
          );
      } finally {
        if (!offered) {
          controller.abort();
          if (owner === controller) owner = undefined;
        }
      }
    },
  };
}

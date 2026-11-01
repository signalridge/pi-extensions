import { createHash, randomUUID } from "node:crypto";
import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionContext,
  InputEvent,
  MessageStartEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * arming.ts — a keyword that tells the model a workflow is appropriate this turn.
 * It is advisory prompt guidance, not an execution-time permission gate.
 *
 * Typing the bounded word `workflow` (or `workflows`, or a configured synonym)
 * in an ordinary message is an explicit opt-in to multi-agent orchestration, so
 * hidden model context tells the model the tool is available for this
 * turn. Two properties matter, and both are easy to get wrong:
 *
 *  1. **Arming authorizes; it does not compel.** The directive says the model
 *     MAY run a workflow and may still decline, so "how do workflows work?"
 *     stays an ordinary question with an ordinary answer. A trigger that forced
 *     a run would make the word unusable in conversation.
 *
 *  2. **Only a real word counts.** A workflow is something people also write
 *     code about, so `myworkflow`, `workflow_name`, `src/workflow-editor.ts`,
 *     `workflow.ts`, and `--workflow-id` must not arm anything. A bare `\b`
 *     boundary is not enough: it treats `-`, `/`, and `.` as separators, so it
 *     matches inside every one of those but the identifier.
 */

/** The word that arms the tool when no synonym is configured. */
export const DEFAULT_TRIGGER_WORD = "workflow";

/**
 * Hidden guidance for an armed turn. Phrased as permission with an explicit escape
 * hatch: the model is told the user opted in, and told it may still answer
 * directly when a workflow would be overkill.
 */
export const WORKFLOW_ARMED_DIRECTIVE =
  "<system-reminder>You typed the workflow trigger word, which counts as an explicit opt-in to multi-agent orchestration: the `workflow` tool is authorized for this turn. It runs in the background by default — the turn ends and the result is delivered back into the conversation when it finishes, which is expected rather than a stall, so you need not stay and block. Pass background:false only when the user is waiting for the result inline. This is permission, not an instruction: if the request is conversational, trivial, or better answered directly, answer it directly and do not run a workflow.</system-reminder>";

/** Standing effort is permission, but does not imply the user typed a keyword. */
export const WORKFLOW_EFFORT_ARMED_DIRECTIVE = WORKFLOW_ARMED_DIRECTIVE.replace(
  "You typed the workflow trigger word, which counts as an explicit opt-in to multi-agent orchestration:",
  "The standing /effort setting permits multi-agent orchestration:",
);

/** Legacy explicit-call helper. Never apply it to native user text or context. */
export function deduplicateWorkflowDirective(text: string): string {
  let seen = false;
  return text.replaceAll(WORKFLOW_ARMED_DIRECTIVE, (directive) => {
    if (seen) return "";
    seen = true;
    return directive;
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Token boundaries that treat identifier, path, and flag punctuation as PART of
 * the token rather than as a separator. `\p{ID_Continue}` covers letters,
 * digits and `_`; `/`, `-` and `$` are added so paths, kebab-case identifiers,
 * and flags are each one token.
 *
 * A trailing `.` is the one case that cannot be decided by the character alone:
 * `workflow.ts` is a filename, but `a workflow.` is a sentence, and ending a
 * sentence with the word is far too common to refuse. So a following dot blocks
 * the match only when something continues the token after it — the second
 * lookahead below. A LEADING dot stays disqualifying (`.workflow` reads as a
 * dotfile or a property access, never as prose).
 */
function triggerRegex(word: string): RegExp {
  const escaped = escapeRegExp(word);
  // The default word is the only one that also matches its plural: a configured
  // synonym is matched exactly as the user spelled it.
  const plural = word === DEFAULT_TRIGGER_WORD ? "s?" : "";
  return new RegExp(
    `(?<![/.$\\-\\p{ID_Continue}])${escaped}${plural}(?![/$\\-\\p{ID_Continue}])(?!\\.\\p{ID_Continue})`,
    "iu",
  );
}

/**
 * Whether `text` contains the trigger word as a standalone word.
 *
 * Arms:      "run a workflow", "workflows, please", "use the WORKFLOW tool"
 * Does not:  "myworkflow", "workflow_name", "src/workflow-editor.ts",
 *            "workflow.ts", "--workflow-id", "/workflows" (a slash command)
 */
export function hasTriggerWord(text: string, configuredWord?: string): boolean {
  return triggerRegex(configuredWord ?? DEFAULT_TRIGGER_WORD).test(text);
}

export const WORKFLOW_ARMING_MESSAGE_TYPE = "pi-workflows:turn-arming";

function effortDirective(level: "off" | "high" | "ultra"): string {
  return level === "ultra"
    ? 'Effort: ULTRA. Be exhaustive: use broad parallel review, verification, and completeness checks. Width is where the exhaustiveness goes: keep steps at strength: "medium" and reserve "high" for a step whose error is expensive to reverse, if the run has one at all.'
    : level === "high"
      ? "Effort: HIGH. Be thorough: use several independent reviewers and an adversarial verification pass."
      : "";
}

type NativeUserMessage = Extract<ContextEvent["messages"][number], { role: "user" }>;

function userText(message: NativeUserMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function inputKey(text: string, images: InputEvent["images"]): string {
  return createHash("sha256")
    .update(JSON.stringify([text, (images ?? []).map((image) => [image.mimeType, image.data])]))
    .digest("hex");
}

function nativeKey(message: NativeUserMessage): string {
  return inputKey(
    userText(message),
    typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image"),
  );
}

type NativeUserIdentity = { key: string; timestamp: number };

function nativeIdentity(message: NativeUserMessage): NativeUserIdentity {
  return { key: nativeKey(message), timestamp: message.timestamp };
}

function sameNativeUser(left: NativeUserIdentity, right: ContextEvent["messages"][number]): boolean {
  return right.role === "user" && right.timestamp === left.timestamp && nativeKey(right) === left.key;
}

/**
 * Public before_agent_start has no source or input ID. Admit only one observed,
 * idle ordinary input, with unchanged text/images/session/leaf. Chained handled
 * input has no public completion event: an unmatched observation makes a later
 * overlapping ordinary input ambiguous rather than transferring its permission.
 * Extension input replaces permission with a denied observation; settlement
 * and navigation retire all observations. Queued input instead binds one bounded
 * admission to a public user message_start, then adds only model context. Multiple
 * unresolved queue admissions are ambiguous. Expanded/transformed input fails
 * closed, and no path changes native history.
 */
export class WorkflowTurnArming {
  private pending:
    | {
        text: string;
        images: string;
        sessionId: string;
        leaf: string | null;
        content?: string;
      }
    | undefined;
  private ambiguous = false;
  private current:
    | {
        id: string;
        key: string;
        message?: NativeUserIdentity;
        sessionId: string;
        anchor: string | null;
        content: string;
      }
    | undefined;
  // One unresolved queued observation is enough. Do not accumulate large input
  // bodies or infer ownership when later handlers consume/reorder/transform them.
  private queued: { key: string; sessionId: string; anchor: string | null; content?: string } | undefined;
  private queuedAmbiguous = false;
  private queuedCurrent:
    | { id: string; message: NativeUserIdentity; sessionId: string; anchor: string | null; content: string }
    | undefined;

  retire(): void {
    this.pending = undefined;
    this.current = undefined;
    this.ambiguous = false;
    this.queued = undefined;
    this.queuedCurrent = undefined;
    this.queuedAmbiguous = false;
  }

  observe(
    event: InputEvent,
    ctx: ExtensionContext,
    armed: boolean,
    effort: "off" | "high" | "ultra",
    explicitTrigger = true,
  ): void {
    const ordinary = event.source === "interactive" || event.source === "rpc";
    const directive = explicitTrigger ? WORKFLOW_ARMED_DIRECTIVE : WORKFLOW_EFFORT_ARMED_DIRECTIVE;
    const content = ordinary && armed ? [directive, effortDirective(effort)].filter(Boolean).join("\n") : undefined;
    if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
      this.queuedAmbiguous ||= this.queued !== undefined || this.pending !== undefined || this.ambiguous;
      this.queued = undefined;
      try {
        if (this.queuedAmbiguous || ctx.isIdle() || event.text.trim().startsWith("/")) return;
        this.queued = {
          key: inputKey(event.text, event.images ?? []),
          sessionId: ctx.sessionManager.getSessionId(),
          anchor: ctx.sessionManager.getLeafId(),
          content,
        };
      } catch {
        this.queuedAmbiguous = true;
      }
      return;
    }
    this.ambiguous ||= this.queued !== undefined || this.queuedAmbiguous;
    this.queued = undefined;
    this.queuedCurrent = undefined;
    this.ambiguous ||= this.pending !== undefined || this.current !== undefined;
    this.current = undefined;
    this.pending = undefined;
    try {
      if (!ctx.isIdle() || event.text.trim().startsWith("/")) return;
      this.pending = {
        text: event.text,
        images: inputKey("", event.images),
        sessionId: ctx.sessionManager.getSessionId(),
        leaf: ctx.sessionManager.getLeafId(),
        content,
      };
    } catch {
      this.pending = undefined;
      this.ambiguous = true; // No public ownership evidence, no arming until settlement.
    }
  }

  consume(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
    // Pi 1.2+ also announces idle custom-message runs; only a user prompt can
    // carry the armed input, and earlier hosts never reached here for them.
    if (event.messageType === "custom") return;
    const pending = this.pending;
    const ambiguous = this.ambiguous;
    this.pending = undefined; // one-use, also for mismatched/consumed prompts
    this.current = undefined;
    try {
      // Pi 1.2+ (which reports messageType) counts the session busy while its
      // own run prepares and queues concurrent sends into it. Earlier hosts were
      // still idle here, so a busy session meant another run had started.
      if (
        ambiguous ||
        !pending?.content ||
        (event.messageType === undefined && !ctx.isIdle()) ||
        event.prompt !== pending.text ||
        inputKey("", event.images) !== pending.images ||
        ctx.sessionManager.getSessionId() !== pending.sessionId ||
        ctx.sessionManager.getLeafId() !== pending.leaf
      )
        return;
      const id = randomUUID();
      this.current = {
        id,
        key: inputKey(event.prompt, event.images ?? []),
        sessionId: pending.sessionId,
        anchor: pending.leaf,
        content: pending.content,
      };
    } catch {
      this.retire();
      return;
    }
  }

  messageStarted(event: MessageStartEvent, ctx: ExtensionContext): void {
    if (event.message.role !== "user") return;
    const message = event.message;
    // The ordinary first message follows its own before_agent_start admission.
    if (this.current && !this.current.message && nativeKey(message) === this.current.key) {
      this.current.message = nativeIdentity(message);
      return;
    }
    this.current = undefined;
    this.queuedCurrent = undefined;
    const queued = this.queued;
    this.queued = undefined; // one-use, even for an unmatched/synthetic message
    try {
      if (
        this.queuedAmbiguous ||
        !queued?.content ||
        queued.key !== nativeKey(message) ||
        queued.sessionId !== ctx.sessionManager.getSessionId() ||
        (queued.anchor !== null && !ctx.sessionManager.getBranch().some((entry) => entry.id === queued.anchor))
      )
        return;
      this.queuedCurrent = {
        id: randomUUID(),
        message: nativeIdentity(message),
        sessionId: queued.sessionId,
        anchor: queued.anchor,
        content: queued.content,
      };
    } catch {
      this.queuedAmbiguous = true;
    }
  }

  filterContext(event: ContextEvent, ctx: ExtensionContext): { messages: ContextEvent["messages"] } | undefined {
    const lastUser = [...event.messages].reverse().find((message) => message.role === "user");
    // Only extension-owned messages are removed. User content is opaque, even
    // when it quotes our directive verbatim. Rebuild a single request-local copy.
    const messages = event.messages.filter(
      (message) => message.role !== "custom" || message.customType !== WORKFLOW_ARMING_MESSAGE_TYPE,
    );
    const queued = this.queuedCurrent ?? this.current;
    const identity = queued?.message;
    let injected = false;
    try {
      // Public context dispatch clones messages. Match the emitted timestamp and
      // content against a UNIQUE native entry on this branch and in model context;
      // equal-text collisions or transformations must not transfer permission.
      if (
        queued &&
        identity &&
        lastUser &&
        sameNativeUser(identity, lastUser) &&
        event.messages.filter((message) => sameNativeUser(identity, message)).length === 1 &&
        queued.sessionId === ctx.sessionManager.getSessionId() &&
        ctx.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "message" && sameNativeUser(identity, entry.message)).length === 1 &&
        (queued.anchor === null || ctx.sessionManager.getBranch().some((entry) => entry.id === queued.anchor))
      ) {
        injected = true;
        messages.push({
          role: "custom",
          customType: WORKFLOW_ARMING_MESSAGE_TYPE,
          content: queued.content,
          display: false,
          details: { id: queued.id },
          timestamp: identity.timestamp,
        });
      }
    } catch {
      this.queuedCurrent = undefined;
    }
    return injected || messages.length !== event.messages.length ? { messages } : undefined;
  }
}

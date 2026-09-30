import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  UserMessage,
} from "@earendil-works/pi-ai";
import { sanitizeSingleLine } from "./text.js";

export const BTW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];

export interface SideQuestionAuth {
  apiKey?: string;
  baseUrl?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
}

export type CompleteSimpleFunction = <TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export type SideThreadTurn =
  | {
      kind: "answered";
      question: string;
      answer: string;
      response: AssistantMessage;
    }
  | {
      kind: "error";
      question: string;
      answer: string;
    };

export interface SideThread {
  turns: SideThreadTurn[];
  /** A parent-history request binds all later side messages to this physical destination. */
  parentHistoryRecipient?: Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl">;
}

export function createSideThread(): SideThread {
  return { turns: [] };
}

export function canSendSideThreadToModel(thread: SideThread, model: Model<Api>): boolean {
  const recipient = thread.parentHistoryRecipient;
  return (
    !recipient ||
    (recipient.provider === model.provider &&
      recipient.id === model.id &&
      recipient.api === model.api &&
      recipient.baseUrl === model.baseUrl)
  );
}

export function bindSideThreadToModel(thread: SideThread, model: Model<Api>): void {
  thread.parentHistoryRecipient ??= {
    provider: model.provider,
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
  };
}

export function sideThreadDestinationError(thread: SideThread): string {
  const recipient = thread.parentHistoryRecipient;
  return `This side thread shared unfiltered parent history with ${sanitizeSingleLine(`${recipient?.provider}/${recipient?.id}`)}. Start a fresh /btw side thread before switching models or endpoints.`;
}

/** Parent history is supplied only to the current request, never stored in a resumable turn. */
export function buildSideThreadMessages(thread: SideThread, question: string, parentContext = ""): Message[] {
  const answeredTurns = thread.turns.filter(
    (turn): turn is Extract<SideThreadTurn, { kind: "answered" }> => turn.kind === "answered",
  );
  const messages: Message[] = [];

  if (answeredTurns.length === 0) {
    messages.push(createUserMessage(buildUserPrompt(question, parentContext)));
    return messages;
  }

  const [first, ...rest] = answeredTurns;
  messages.push(createUserMessage(buildUserPrompt(first.question)), first.response);
  for (const turn of rest) {
    messages.push(createUserMessage(buildFollowUpPrompt(turn.question)), turn.response);
  }
  messages.push(createUserMessage(buildFollowUpPrompt(question, parentContext)));
  return messages;
}

export interface CompleteSideThreadTurnOptions {
  thread: SideThread;
  model: Model<Api>;
  question: string;
  thinkingLevel: BtwThinkingLevel;
  auth: SideQuestionAuth;
  signal?: AbortSignal;
  completeSimple: CompleteSimpleFunction;
  /** Called immediately before the provider request; false cancels a stale session. */
  prepareContext?: () => string | false;
}

export type CompleteSideThreadTurnResult =
  | { kind: "answered"; response: AssistantMessage; answer: string }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

export async function completeSideThreadTurn({
  thread,
  model,
  question,
  thinkingLevel,
  auth,
  signal,
  completeSimple,
  prepareContext,
}: CompleteSideThreadTurnOptions): Promise<CompleteSideThreadTurnResult> {
  if (signal?.aborted) return { kind: "aborted" };
  try {
    const requestModel = withResolvedBaseUrl(model, auth);
    if (!canSendSideThreadToModel(thread, requestModel)) {
      return { kind: "error", message: sideThreadDestinationError(thread) };
    }
    const parentContext = prepareContext?.() ?? "";
    if (parentContext === false) return { kind: "aborted" };
    if (parentContext) bindSideThreadToModel(thread, requestModel);
    const response = await completeSimple(
      requestModel,
      { systemPrompt: SYSTEM_PROMPT, messages: buildSideThreadMessages(thread, question, parentContext) },
      buildStreamOptions(auth, thinkingLevel, signal),
    );
    if (signal?.aborted || response?.stopReason === "aborted") return { kind: "aborted" };
    if (!isAssistantMessage(response)) {
      return { kind: "error", message: "The side model returned a malformed response." };
    }
    if (response.stopReason === "error") {
      return {
        kind: "error",
        message: response.errorMessage ?? "The side model returned an error.",
      };
    }

    const answer = extractAssistantText(response) || "No response received.";
    thread.turns.push({ kind: "answered", question, answer, response });
    return { kind: "answered", response, answer };
  } catch (error: unknown) {
    if (signal?.aborted) return { kind: "aborted" };
    return { kind: "error", message: formatError(error) };
  }
}

export interface CompleteSideQuestionOptions {
  model: Model<Api>;
  question: string;
  conversationContext: string;
  thinkingLevel: BtwThinkingLevel;
  auth: SideQuestionAuth;
  signal?: AbortSignal;
  completeSimple: CompleteSimpleFunction;
}

export async function completeSideQuestion({
  model,
  question,
  conversationContext,
  thinkingLevel,
  auth,
  signal,
  completeSimple,
}: CompleteSideQuestionOptions): Promise<AssistantMessage> {
  const requestModel = withResolvedBaseUrl(model, auth);
  return completeSimple(
    requestModel,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [createUserMessage(buildUserPrompt(question, conversationContext))],
    },
    buildStreamOptions(auth, thinkingLevel, signal),
  );
}

export function extractAssistantText(response: AssistantMessage): string {
  return response.content
    .filter(
      (content): content is { type: "text"; text: string } =>
        content !== null && typeof content === "object" && content.type === "text" && typeof content.text === "string",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AssistantMessage>;
  return candidate.role === "assistant" && Array.isArray(candidate.content) && typeof candidate.stopReason === "string";
}

export function buildUserPrompt(question: string, conversationContext = ""): string {
  return [
    "Answer this side question without modifying the main conversation.",
    "",
    "<side_question>",
    question,
    "</side_question>",
    ...parentContextSection(conversationContext),
  ].join("\n");
}

export function buildFollowUpPrompt(question: string, conversationContext = ""): string {
  return [
    "Continue the same side conversation.",
    "",
    "<side_question>",
    question,
    "</side_question>",
    ...parentContextSection(conversationContext),
  ].join("\n");
}

function parentContextSection(context: string): string[] {
  return context ? ["", "<conversation_context>", context, "</conversation_context>"] : [];
}

function createUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function withResolvedBaseUrl<TApi extends Api>(model: Model<TApi>, auth: SideQuestionAuth): Model<TApi> {
  return auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
}

function buildStreamOptions(
  auth: SideQuestionAuth,
  thinkingLevel: BtwThinkingLevel,
  signal?: AbortSignal,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
  };
  if (thinkingLevel !== "off") options.reasoning = thinkingLevel;
  return options;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SYSTEM_PROMPT = `You answer quick side questions for a coding-agent user.

Answer the user's side question directly and concisely. If conversation context was explicitly shared for this request, use it only as background. Do not claim to have changed files, run tools, or affected the main task. If information is insufficient, say what is unknown and give the best next step.`;

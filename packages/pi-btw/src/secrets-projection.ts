import { types } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureSessionOrigin } from "./session-origin.js";

export type TextProjection = (texts: readonly string[]) => readonly string[];
const EVENT = "pi-secrets:projection:v1";
const FAILURE = "Secret projection unavailable; the side request was withheld.";

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return (
    (proto === Object.prototype || proto === null) &&
    Reflect.ownKeys(value).every((key) => "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}))
  );
}

/** Discover at request time, not extension load time. Only zero synchronous claims means absent. */
export function createSecretsProjection(
  events: ExtensionAPI["events"] | undefined,
  ctx: Pick<ExtensionContext, "sessionManager">,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): TextProjection | undefined {
  if (!events) return undefined;
  const origin = captureSessionOrigin(ctx);
  const manager = ctx.sessionManager;
  const claims: unknown[] = [];
  let accepting = true;
  let project: (request: unknown) => unknown;
  try {
    events.emit(
      EVENT,
      Object.freeze({
        version: 1,
        accept: (claim: unknown) => {
          if (accepting && claims.length < 2) claims.push(claim);
        },
      }),
    );
    accepting = false;
    if (claims.length === 0) return undefined;
    const claim = claims[0];
    if (claims.length !== 1 || !record(claim) || claim.version !== 1 || typeof claim.project !== "function") {
      throw new Error(FAILURE);
    }
    project = claim.project as typeof project;
  } catch {
    // Discovery and descriptor/prototype traps are as untrusted as invocation errors.
    throw new Error(FAILURE);
  } finally {
    accepting = false;
  }
  return (input) => {
    try {
      if (signal?.aborted || !isCurrent() || !origin()) throw new Error(FAILURE);
      const result: unknown = project(
        Object.freeze({
          version: 1,
          sessionId: manager.getSessionId(),
          leafId: manager.getLeafId(),
          texts: Object.freeze([...input]),
        }),
      );
      if (types.isPromise(result)) {
        // Native promise detection works across realms without consulting thenable getters.
        // Use the intrinsic observer, not an overridable .then/.catch property.
        void Promise.prototype.then.call(
          result,
          () => undefined,
          () => undefined,
        );
        throw new Error(FAILURE);
      }
      if (
        !record(result) ||
        result.version !== 1 ||
        result.ok !== true ||
        !Array.isArray(result.texts) ||
        Object.getPrototypeOf(result.texts) !== Array.prototype ||
        result.texts.length !== input.length ||
        result.texts.length > 50_000 ||
        Reflect.ownKeys(result.texts).length !== result.texts.length + 1
      ) {
        throw new Error(FAILURE);
      }
      const output: string[] = [];
      let size = 0;
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(result.texts, String(index));
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") throw new Error(FAILURE);
        output.push(descriptor.value);
        size += descriptor.value.length;
        if (size > 8 * 1024 * 1024) throw new Error(FAILURE);
      }
      if (signal?.aborted || !isCurrent() || !origin()) throw new Error(FAILURE);
      return output;
    } catch {
      // Provider exceptions may contain secrets; never relay their message.
      throw new Error(FAILURE);
    }
  };
}

/** Check the effective JSON hook without invoking getters or user serializers. */
function rejectJsonHook(value: object): void {
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value === "function") throw new Error(FAILURE);
    return;
  }
}

/** Local JSON data projection, not a second secret detector or settings schema. */
export function projectJson<T>(value: T, project: TextProjection): T {
  const texts: string[] = [];
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, map: (text: string) => string): unknown => {
    if (++nodes > 100_000) throw new Error(FAILURE);
    if (item !== null && (typeof item === "object" || typeof item === "function")) rejectJsonHook(item);
    if (typeof item === "string") return map(item);
    if (item === null || typeof item !== "object") return item;
    if (ancestors.has(item) || ancestors.size >= 100) throw new Error(FAILURE);
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) throw new Error(FAILURE);
    ancestors.add(item);
    let changed = false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Object.getOwnPropertyNames(item)) {
      const descriptor = descriptors[key];
      const jsonIndex = Array.isArray(item) && /^(0|[1-9]\d*)$/.test(key) && Number(key) < item.length;
      if (!descriptor?.enumerable && !jsonIndex) continue;
      if (!descriptor || !("value" in descriptor)) throw new Error(FAILURE);
      const next = visit(descriptor.value, map);
      if (next !== descriptor.value) changed = true;
      descriptor.value = next;
    }
    ancestors.delete(item);
    return changed ? Object.defineProperties(Array.isArray(item) ? [] : Object.create(proto), descriptors) : item;
  };
  let size = 0;
  visit(value, (text) => {
    texts.push(text);
    size += text.length;
    if (texts.length > 50_000 || size > 8 * 1024 * 1024) throw new Error(FAILURE);
    return text;
  });
  const output = project(texts);
  let index = 0;
  nodes = 0;
  return visit(value, () => output[index++]) as T;
}

/** Only request text, never opaque image/signature bytes or the stored response. */
export function projectSideMessages(messages: Message[], project: TextProjection): Message[] {
  const texts: string[] = [];
  const mapMessages = (map: (text: string) => string): Message[] =>
    messages.map((message) => {
      if (message.role === "user") {
        return {
          ...message,
          content:
            typeof message.content === "string"
              ? map(message.content)
              : message.content.map((block) => (block.type === "text" ? { ...block, text: map(block.text) } : block)),
        };
      }
      if (message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => {
          if (block.type === "text") return { ...block, text: map(block.text) };
          if (block.type === "thinking" && !block.redacted) {
            const thinking = map(block.thinking);
            return thinking === block.thinking ? block : { ...block, thinking, thinkingSignature: undefined };
          }
          if (block.type === "toolCall") {
            const args = projectJson(block.arguments, (items) => items.map(map));
            return args === block.arguments ? block : { ...block, arguments: args, thoughtSignature: undefined };
          }
          return block;
        }),
      };
    });
  mapMessages((text) => {
    texts.push(text);
    return text;
  });
  const output = project(texts);
  let index = 0;
  return mapMessages(() => output[index++]);
}

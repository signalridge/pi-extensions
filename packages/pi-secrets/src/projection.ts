import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SecretsSession } from "./session.js";

/** Public, synchronous, in-process capability discovery; not provider authentication. */
export const PROJECTION_EVENT = "pi-secrets:projection:v1";
const MAX_TEXTS = 50_000;
const MAX_CHARS = 8 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return (
    (proto === Object.prototype || proto === null) &&
    Reflect.ownKeys(value).every((key) => "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}))
  );
}

function texts(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_TEXTS ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return false;
  let size = 0;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return false;
    size += descriptor.value.length;
    if (size > MAX_CHARS) return false;
  }
  return true;
}

/** Always advertises when loaded, even while unavailable: errors must not look like absence. */
export function registerProjection(
  pi: ExtensionAPI,
  current: () => { session: SecretsSession; ctx: ExtensionContext } | undefined,
): void {
  pi.events.on(PROJECTION_EVENT, (query: unknown) => {
    if (!record(query) || query.version !== 1 || typeof query.accept !== "function") return;
    const owner = current();
    const project = (request: unknown): unknown => {
      try {
        if (
          !owner ||
          current() !== owner ||
          !record(request) ||
          request.version !== 1 ||
          typeof request.sessionId !== "string" ||
          !(request.leafId === null || typeof request.leafId === "string") ||
          !texts(request.texts)
        ) {
          return { version: 1, ok: false };
        }
        const manager = owner.ctx.sessionManager;
        if (manager.getSessionId() !== request.sessionId || manager.getLeafId() !== request.leafId) {
          return { version: 1, ok: false };
        }
        // Whole batch discovery precedes every emission, including cached-token aliases.
        for (const text of request.texts) owner.session.registry.discover(text);
        const projected = request.texts.map((text) => owner.session.registry.obfuscate(text).text);
        if (!texts(projected)) return { version: 1, ok: false };
        return { version: 1, ok: true, texts: projected };
      } catch {
        if (owner) owner.session.stats.failures += 1;
        return { version: 1, ok: false };
      }
    };
    query.accept(Object.freeze({ version: 1, project }));
  });
}

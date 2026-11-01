import type { StatusContext } from "./types.js";

export const STATUS_KEY = "lsp";

// Calls receive distinct contexts/UI wrappers, but share the host session identity.
const sessions = new Map<string | object, Map<string, Map<symbol, string>>>();

function sessionIdentity(ctx: StatusContext): string | object {
  try {
    return ctx.statusOwner ?? ctx.sessionManager?.getSessionId() ?? ctx.ui;
  } catch {
    // Runner-only contexts can lack a session owner and have an unavailable UI.
    return ctx;
  }
}

export function resetStatus(ctx: StatusContext, key: string): void {
  const identity = sessionIdentity(ctx);
  const keys = sessions.get(identity);
  keys?.delete(key);
  if (keys?.size === 0) sessions.delete(identity);
  publishStatus(ctx, key, undefined);
}

export function beginStatus(ctx: StatusContext, key: string, label: string): () => void {
  const identity = sessionIdentity(ctx);
  let keys = sessions.get(identity);
  if (!keys) {
    keys = new Map();
    sessions.set(identity, keys);
  }
  let active = keys.get(key);
  if (!active) {
    active = new Map();
    keys.set(key, active);
  }
  const token = Symbol(label);
  active.set(token, label);
  // Only this token may complete this entry; a lifecycle reset invalidates the whole map.
  const finish = () => {
    if (sessions.get(identity)?.get(key) !== active || !active.delete(token)) return;
    const remaining = [...active.values()].at(-1);
    if (active.size === 0) {
      keys.delete(key);
      if (keys.size === 0) sessions.delete(identity);
    }
    publishStatus(ctx, key, remaining);
  };
  publishStatus(ctx, key, label);
  return finish;
}

function publishStatus(ctx: StatusContext, key: string, value: string | undefined) {
  try {
    // Undefined mode supports runner-only contexts; host tool contexts always
    // declare a mode, and only TUI status is meaningful there.
    if (ctx.mode !== undefined && ctx.mode !== "tui") return;
    ctx.ui.setStatus(key, value);
  } catch {
    // A stale SDK getter or unavailable UI must never bypass client cleanup or
    // replace an operation's original result/error.
  }
}

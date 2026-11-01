import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Reload is not cancellable. Retain only outstanding physical mutations across
// factory replacement, keyed weakly by the public session manager, so a fresh
// runtime still vetoes navigation until the old setModel call has settled.
const key = Symbol.for("@signalridge/pi-plan-mode/model-mutations/v1");
const shared = globalThis as typeof globalThis & { [key]?: WeakMap<object, number> };
const mutations = shared[key] ?? new WeakMap<object, number>();
shared[key] = mutations;

export function modelMutationPending(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
  return (mutations.get(ctx.sessionManager) ?? 0) > 0;
}

export async function mutateModel<T>(ctx: Pick<ExtensionContext, "sessionManager">, run: () => Promise<T>): Promise<T> {
  const manager = ctx.sessionManager;
  mutations.set(manager, (mutations.get(manager) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const remaining = (mutations.get(manager) ?? 1) - 1;
    if (remaining > 0) mutations.set(manager, remaining);
    else mutations.delete(manager);
  }
}

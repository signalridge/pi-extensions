import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

function isSameModel(candidate: unknown, selected: { provider: string; id: string }): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const model = candidate as { provider?: unknown; id?: unknown };
  return model.provider === selected.provider && model.id === selected.id;
}

/**
 * Pi 0.80.8+ requires the parent's ModelRuntime, not just its public registry
 * facade. ExtensionContext does not expose that runtime. Keep the one private
 * compatibility read here until Pi provides a public accessor. Passing no
 * runtime on a modern host silently creates a fresh one, losing extension
 * providers, credentials and virtual routes before the first child request.
 * Without selectedModel, check only the runtime's shape: the parent ctx.model
 * may be stale while the child explicitly selects a valid physical model.
 */
export function parentModelSessionOptions(
  ctx: ExtensionContext,
  selectedModel?: { provider: string; id: string },
): {
  modelRegistry: ExtensionContext["modelRegistry"];
  modelRuntime?: ModelRuntime;
} {
  const modelRegistry = ctx.modelRegistry;
  const modernHost = typeof PiCodingAgent.ModelRuntime?.create === "function";
  let candidate: unknown;
  try {
    candidate = (modelRegistry as unknown as { runtime?: unknown }).runtime;
  } catch {
    // Treat an inaccessible private bridge exactly like a missing one; never
    // include accessor errors, which might contain provider configuration.
  }
  let compatible = false;
  try {
    if (candidate !== null && typeof candidate === "object") {
      const runtime = candidate as Record<string, unknown>;
      // Pi 0.84/0.87 already have ModelRuntime.create but no resolveModel;
      // virtual routing is a 0.99 feature. Check the shared child-session
      // capabilities available across all supported runtime generations.
      compatible = typeof runtime.getAuth === "function" && typeof runtime.stream === "function" &&
        typeof runtime.getModel === "function" && typeof runtime.streamSimple === "function";
      if (compatible && modernHost && selectedModel) {
        const model = (runtime.getModel as (provider: string, id: string) => unknown)(selectedModel.provider, selectedModel.id);
        compatible = isSameModel(model, selectedModel);
      }
    }
  } catch {
    compatible = false;
  }
  if (modernHost && !compatible) {
    throw new Error(
      "Cannot start a child session: Pi exposes ModelRuntime.create but the parent's model runtime is unavailable or incompatible. " +
        "Update Pi to a host that exposes the parent runtime to extensions, or disable subagent/mention dispatch; " +
        "a fresh runtime would lose custom providers and virtual model routes.",
    );
  }
  return {
    modelRegistry, // older supported hosts still consume this option
    ...(compatible ? { modelRuntime: candidate as ModelRuntime } : {}),
  };
}

/** Admit a spawn before allocating any identity; final model validation stays in runAgent. */
export function assertParentModelRuntimeAvailable(ctx: ExtensionContext): void {
  parentModelSessionOptions(ctx);
}

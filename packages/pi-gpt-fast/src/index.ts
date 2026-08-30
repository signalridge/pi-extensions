/**
 * /gpt-fast — OpenAI priority service tier for pi.
 *
 * OpenAI's Responses API accepts `service_tier: "priority"`, which buys lower
 * latency on the same model. pi exposes `before_provider_request`, whose return
 * value REPLACES the outgoing payload, so a request can be upgraded in flight
 * without touching model or reasoning effort — this is a latency switch, not a
 * quality downgrade.
 *
 * Prior art (studied 2026-08-09, both do the same injection):
 *   - github.com/calesennett/pi-codex-fast      `/codex-fast`, ships a benchmark:
 *     1.57x wall on gpt-5.6-sol, 2.25x on gpt-5.6-luna over three paired trials.
 *   - github.com/johncmunson/pi-openai-fast-mode `/fast`, MIT, on npm.
 * This is an independent implementation: the first carries no license at all
 * (package.json `license: null`, no LICENSE file) so its code cannot be
 * vendored, and neither offers the `/gpt-fast` name. Behaviour here follows the
 * former's shape — `setStatus` rather than a widget, so the indicator folds into
 * the statusline's extension row instead of costing a whole line, plus
 * session_start restoration, which the npm package lacks.
 *
 * Off by default. State persists in ~/.pi/agent/settings.json under
 * `pi-gpt-fast.enabled`. If a dotfile manager owns that file, it must merge
 * rather than overwrite — a template that rewrites the whole file drops the
 * toggle on every apply.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "gpt-fast";
const SETTINGS_KEY = "pi-gpt-fast";

/**
 * Exact provider/model pairs known to accept the priority tier. An allowlist,
 * not a prefix match: sending `service_tier` to a provider that rejects unknown
 * fields fails the whole request, so a wrong guess costs a turn rather than
 * degrading quietly. krill is deliberately absent — it is an OpenAI-compatible
 * gateway whose tier support is unverified; add it here once it is.
 */
const PRIORITY_MODELS = new Set([
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.6",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai/gpt-5.6",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentModel(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined;
}

function modelSupportsPriority(ctx: ExtensionContext): boolean {
  const name = currentModel(ctx);
  return name !== undefined && PRIORITY_MODELS.has(name);
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readEnabled(): boolean {
  try {
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    const block = settings?.[SETTINGS_KEY];
    return isRecord(block) && block.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Read-modify-write the whole settings file. pi rewrites this file too, so the
 * read happens at write time rather than from a cached copy — a stale snapshot
 * here would silently revert whatever pi changed in between.
 *
 * The write is atomic for the same reason. This is pi's own settings file,
 * shared with pi and every other extension, and it is rewritten on every toggle
 * of this feature. A torn write — crash, kill, disk full between truncate and
 * flush — would leave the user with no pi configuration at all, not just no
 * gpt-fast setting. Write a unique temp file in the same directory, then rename
 * over the target; rename is atomic on POSIX and Windows.
 */
function writeEnabled(enabled: boolean): void {
  const path = settingsPath();
  const raw = (() => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  })();
  const settings = isRecord(raw) ? raw : {};
  const block = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  settings[SETTINGS_KEY] = { ...block, enabled };
  const document = `${JSON.stringify(settings, null, 2)}\n`;
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporaryPath, document, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup must not replace the write result.
    }
  }
}

export default function (pi: ExtensionAPI) {
  let enabled = false;

  const refreshStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    if (!enabled) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    // "armed" says the toggle is on but the current model is not on the
    // allowlist, so nothing is actually being injected. Without the distinction
    // a silent no-op looks identical to a working fast mode.
    ctx.ui.setStatus(STATUS_KEY, modelSupportsPriority(ctx) ? "fast" : "fast (armed)");
  };

  const apply = (next: boolean, ctx: ExtensionContext, announce = true): void => {
    enabled = next;
    try {
      writeEnabled(next);
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`gpt-fast: could not persist state: ${message}`, "warning");
      }
    }
    refreshStatus(ctx);
    if (!announce || !ctx.hasUI) return;

    const model = currentModel(ctx) ?? "no active model";
    if (!next) {
      ctx.ui.notify("Fast mode off — default service tier.", "info");
    } else if (modelSupportsPriority(ctx)) {
      ctx.ui.notify(`Fast mode on — priority tier for ${model}.`, "info");
    } else {
      ctx.ui.notify(
        `Fast mode on, but ${model} is not on the priority allowlist — no effect until you switch models.`,
        "warning",
      );
    }
  };

  pi.registerFlag("gpt-fast", {
    description: "Start with OpenAI priority service tier enabled",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("gpt-fast", {
    description: "Toggle the OpenAI priority service tier (on | off | toggle)",
    getArgumentCompletions: (prefix: string) =>
      ["on", "off", "toggle"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== "on" && arg !== "off" && arg !== "toggle") {
        ctx.ui.notify(`gpt-fast: expected on, off or toggle — got "${arg}".`, "error");
        return;
      }
      apply(arg === "on" ? true : arg === "off" ? false : !enabled, ctx);
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    enabled = readEnabled() || pi.getFlag("gpt-fast") === true;
    refreshStatus(ctx);
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  // session_start fires for startup, new sessions, resumes, and forks, so restore reads the current settings.
  // The allowlist is model-scoped, so the indicator has to follow /model.
  pi.on("model_select", (_event, ctx) => refreshStatus(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !modelSupportsPriority(ctx) || !isRecord(event.payload)) {
      // Returning undefined leaves the payload untouched.
      return;
    }
    return { ...event.payload, service_tier: "priority" };
  });
}

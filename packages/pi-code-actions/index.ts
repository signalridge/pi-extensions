import type { ExtensionAPI, ExtensionCommandContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { copySnippet, insertIntoEditor, runSnippet } from "./src/actions.js";
import type { Snippet } from "./src/snippets.js";
import { extractSnippets, extractText } from "./src/snippets.js";
import type { PickResult } from "./src/ui.js";
import { pickAction, pickSnippet } from "./src/ui.js";

type ParsedArgs = {
  scope: "last" | "all";
  action?: "copy" | "insert" | "run";
  index?: number;
  includeInline: boolean;
  limit: number;
};

function parseArgs(args?: string): ParsedArgs {
  const tokens = args?.trim().split(/\s+/).filter(Boolean) ?? [];
  const parsed: ParsedArgs = { scope: "all", includeInline: true, limit: 200 };

  for (const token of tokens) {
    if (token === "all" || token === "last") {
      parsed.scope = token;
      continue;
    }
    if (token === "inline") {
      parsed.includeInline = true;
      continue;
    }
    if (token === "blocks") {
      parsed.includeInline = false;
      continue;
    }
    if (token === "copy" || token === "insert" || token === "run") {
      parsed.action = token;
      continue;
    }
    if (token.startsWith("limit=")) {
      const value = Number.parseInt(token.slice("limit=".length), 10);
      if (!Number.isNaN(value) && value > 0) parsed.limit = value;
      continue;
    }
    if (/^\d+$/.test(token)) {
      parsed.index = Math.max(0, Number.parseInt(token, 10) - 1);
    }
  }

  return parsed;
}

type AssistantEntry = SessionMessageEntry & {
  message: { role: "assistant"; content: unknown };
};

function collectSnippets(
  ctx: ExtensionCommandContext,
  scope: "last" | "all",
  includeInline: boolean,
  limit: number,
): Snippet[] {
  const branchEntries = ctx.sessionManager.getBranch();
  const assistantEntries = branchEntries.filter((entry): entry is AssistantEntry => {
    if (entry.type !== "message") return false;
    const message = entry.message as unknown as { role?: unknown; content?: unknown };
    return message.role === "assistant" && "content" in message;
  });

  if (assistantEntries.length === 0) return [];

  const sorted = assistantEntries.slice().sort((a, b) => {
    const aTime = Date.parse(a.timestamp);
    const bTime = Date.parse(b.timestamp);
    return bTime - aTime;
  });

  const entriesToScan = scope === "all" ? sorted : sorted.slice(0, 1);

  let snippets: Snippet[] = [];
  let nextId = 0;
  for (const entry of entriesToScan) {
    if (snippets.length >= limit) break;
    const message = entry.message;
    if (!message) continue;
    const text = extractText(message.content);
    if (!text) continue;
    const label = new Date(entry.timestamp).toLocaleTimeString();
    const extracted = extractSnippets(text, entry.id, label, nextId, includeInline, limit - snippets.length);
    snippets = snippets.concat(extracted);
    nextId = snippets.length;
  }

  return snippets;
}

export default function codeActionsExtension(pi: ExtensionAPI) {
  let owner: { sessionId: string; leafId: string | null; controller: AbortController } | undefined;
  const runs = new Set<Promise<void>>();
  let stopped = false;
  const retire = () => {
    const previous = owner;
    owner = undefined;
    previous?.controller.abort();
    // Navigation/shutdown must wait for bounded process cleanup, not only abort the shell.
    return Promise.allSettled(runs).then(() => {});
  };
  pi.on("session_before_switch", retire);
  pi.on("session_before_fork", retire);
  pi.on("session_before_tree", retire);
  pi.on("session_start", () => {
    const cleanup = retire();
    stopped = false;
    return cleanup;
  });
  pi.on("session_tree", retire);
  pi.on("session_shutdown", () => {
    stopped = true;
    return retire();
  });

  pi.registerCommand("code", {
    description: "Pick code from assistant messages and copy/insert/run it",
    handler: async (args, ctx) => {
      if (stopped) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      if (!owner || owner.sessionId !== sessionId || owner.leafId !== leafId) {
        retire();
        owner = { sessionId, leafId, controller: new AbortController() };
      }
      const captured = owner;
      // Only plain captured state is consulted after awaits: retired contexts may throw on access.
      const operation = {
        signal: captured.controller.signal,
        isCurrent: () => owner === captured && !captured.controller.signal.aborted,
      };

      if (!ctx.hasUI && (!args || args.trim().length === 0)) {
        return;
      }

      const parsed = parseArgs(args);
      const snippets = collectSnippets(ctx, parsed.scope, parsed.includeInline, parsed.limit);

      if (snippets.length === 0) {
        if (ctx.hasUI) ctx.ui.notify("No code snippets found. /code tracks code blocks and filepaths only.", "warning");
        return;
      }

      let snippet: Snippet | undefined;
      let pickedAction: PickResult["action"] | undefined;
      if (parsed.index !== undefined) {
        snippet = snippets[parsed.index];
        if (!snippet) {
          if (ctx.hasUI) ctx.ui.notify("Snippet index out of range.", "warning");
          return;
        }
      } else {
        if (ctx.mode !== "tui") {
          if (ctx.hasUI)
            ctx.ui.notify("The /code picker requires TUI mode. Supply an index and action instead.", "warning");
          return;
        }
        const result = await pickSnippet(ctx, snippets, operation);
        if (!operation.isCurrent() || !result) return;
        snippet = result.snippet;
        pickedAction = result.action;
      }

      let action = parsed.action ?? pickedAction;
      if (!action) {
        if (!ctx.hasUI) return;
        action = await pickAction(ctx, operation);
      }
      if (!operation.isCurrent() || !action) return;

      if (action === "copy") {
        if (ctx.mode !== "tui") {
          if (ctx.hasUI) ctx.ui.notify("Clipboard copying is unavailable outside TUI mode.", "warning");
          return;
        }
        const result = await copySnippet(snippet.content, operation);
        if (!operation.isCurrent()) return;
        if (ctx.hasUI) {
          if (result.copied) ctx.ui.notify("Copied to clipboard.", "info");
          else ctx.ui.notify(`Failed to copy to clipboard: ${result.reason}`, "error");
        }
        return;
      }

      if (action === "insert") {
        if (!ctx.hasUI) return;
        const inserted = await insertIntoEditor(ctx, snippet.content, operation);
        if (!operation.isCurrent() || !inserted) return;
        ctx.ui.notify("Inserted snippet into editor.", "info");
        return;
      }

      if (action === "run") {
        if (!ctx.hasUI) return;
        const cwd = ctx.cwd;
        const ok = await ctx.ui.confirm("Run snippet?", "This will execute the selected snippet in your shell.", {
          signal: operation.signal,
        });
        if (!operation.isCurrent() || !ok) return;
        const running = runSnippet(pi, ctx, snippet.content, operation, cwd);
        runs.add(running);
        try {
          await running;
        } finally {
          runs.delete(running);
        }
      }
    },
  });
}

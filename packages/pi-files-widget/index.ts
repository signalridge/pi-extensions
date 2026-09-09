/**
 * Pi Editor Extension
 *
 * Provides an in-terminal file browser and viewer.
 * Use /readfiles to open the file browser, navigate with j/k, Enter to view.
 */

import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFileBrowser } from "./browser.js";
import { formatCommentMessage } from "./comment.js";
import { POLL_INTERVAL_MS } from "./constants.js";
import { resolveToolPath } from "./paths.js";
import { hasCommand } from "./utils.js";

function resolveInitialPath(arg: string | undefined, cwd: string): { path: string; error?: string } {
  if (!arg) return { path: cwd };
  const candidate = arg.trim();
  if (!candidate) return { path: cwd };
  const absolute = resolveToolPath(candidate, cwd);
  try {
    if (!statSync(absolute).isDirectory()) {
      return { path: cwd, error: `${absolute} is not a directory` };
    }
  } catch {
    return { path: cwd, error: `${absolute} is not accessible` };
  }
  return { path: absolute };
}

// Unknown evidence (permissions/I/O failure) is not a missing file. Metadata
// avoids reading potentially large edited files a second time.
function mutationStamp(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : undefined;
  }
}

export default function editorExtension(pi: ExtensionAPI): void {
  const agentModifiedFiles = new Set<string>();
  const observedChangedFiles = new Set<string>();
  const mutations = new Map<string, { cwd: string; path: string; before: string | undefined }>();
  const requiredDeps = ["bat", "delta", "glow"] as const;
  const getMissingDeps = () => requiredDeps.filter((dep) => !hasCommand(dep));

  pi.registerCommand("readfiles", {
    description: "Open file browser (optional: /readfiles <path> to start outside the current directory)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify("The /readfiles browser requires TUI mode and is unavailable over RPC.", "warning");
        return;
      }
      const cwd = ctx.cwd;
      const missing = getMissingDeps();
      if (missing.length > 0) {
        ctx.ui.notify(`files-widget requires ${missing.join(", ")}. Install: brew install bat git-delta glow`, "error");
        return;
      }

      const resolved = resolveInitialPath(args, cwd);
      if (resolved.error) {
        ctx.ui.notify(resolved.error, "error");
        return;
      }
      const initialPath = resolved.path;
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let pollInterval: ReturnType<typeof setInterval> | null = null;

        const cleanup = () => {
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          done();
        };

        const requestComment = (
          payload: { relPath: string; lineRange: string; ext: string; selectedText: string },
          comment: string,
        ) => {
          const message = formatCommentMessage(payload, comment);
          if (ctx.isIdle()) {
            pi.sendUserMessage(message);
            ctx.ui.notify(`Comment sent to agent for ${payload.relPath} (${payload.lineRange})`, "info");
          } else {
            pi.sendUserMessage(message, { deliverAs: "followUp" });
            ctx.ui.notify(`Comment queued for agent for ${payload.relPath} (${payload.lineRange})`, "info");
          }
        };

        const requestRender = () => tui.requestRender();
        const browser = createFileBrowser(
          initialPath,
          agentModifiedFiles,
          theme,
          cleanup,
          requestComment,
          requestRender,
          cwd,
          observedChangedFiles,
        );

        pollInterval = setInterval(() => {
          requestRender();
        }, POLL_INTERVAL_MS);

        return {
          render: (w) => browser.render(w),
          handleInput: (data) => {
            browser.handleInput(data);
            requestRender();
          },
          invalidate: () => browser.invalidate(),
        };
      });
    },
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (typeof event.input.path !== "string" || !event.input.path) return;
    const path = resolveToolPath(event.input.path, ctx.cwd);
    mutations.set(event.toolCallId, { cwd: ctx.cwd, path, before: mutationStamp(path) });
  });

  pi.on("tool_result", async (event, ctx) => {
    const candidate = mutations.get(event.toolCallId);
    mutations.delete(event.toolCallId);
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const filePath = event.input?.path;
    if (typeof filePath !== "string" || !filePath) return;
    // Later tool_call handlers may rewrite input; retain only the original cwd.
    const path = resolveToolPath(filePath, candidate?.cwd ?? ctx.cwd);
    if (event.isError) {
      if (candidate?.path === path && candidate.before !== undefined) {
        const after = mutationStamp(path);
        // A cancelled write may already be on disk, but a concurrent human save
        // looks identical. Keep the change discoverable without claiming authorship.
        if (after !== undefined && after !== candidate.before && !agentModifiedFiles.has(path)) {
          observedChangedFiles.add(path);
        }
      }
      return;
    }
    agentModifiedFiles.add(path);
    observedChangedFiles.delete(path);
  });

  pi.on("tool_execution_end", (event) => {
    // Blocked/aborted preflight outcomes bypass tool_result. Executed calls have
    // already reconciled their evidence there before this terminal event fires.
    mutations.delete(event.toolCallId);
  });

  pi.on("session_start", async (_event, ctx) => {
    mutations.clear();
    const missing = ctx.mode === "tui" ? getMissingDeps() : [];
    if (missing.length > 0) {
      ctx.ui.notify(`files-widget requires ${missing.join(", ")}. Install: brew install bat git-delta glow`, "error");
    }

    agentModifiedFiles.clear();
    observedChangedFiles.clear();
  });

  pi.on("session_before_switch", async () => {
    mutations.clear();
    agentModifiedFiles.clear();
    observedChangedFiles.clear();
  });
}

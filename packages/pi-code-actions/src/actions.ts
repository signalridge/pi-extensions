import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

import { type ActionOwnership, ownedCustom } from "./owned-custom.js";
import { executeSnippet } from "./snippet-process.js";

export type { ActionOwnership } from "./owned-custom.js";

export type CopyResult = { copied: true } | { copied: false; reason: string };

const CANCELLED: CopyResult = { copied: false, reason: "cancelled" };

/**
 * Copy through Pi's own clipboard writer, which also reaches remote clients over OSC 52,
 * Termux and WSL. Pi bounds its clipboard utilities with its own timeout and cannot be
 * cancelled, so a retired operation stops waiting and its outcome is never reported.
 */
export async function copySnippet(
  content: string,
  ownership: ActionOwnership,
  write: (text: string) => Promise<void> = copyToClipboard,
): Promise<CopyResult> {
  if (!ownership.isCurrent() || ownership.signal.aborted) return CANCELLED;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<CopyResult>((resolve) => {
    onAbort = () => resolve(CANCELLED);
    ownership.signal.addEventListener("abort", onAbort, { once: true });
  });
  const copying = Promise.resolve()
    .then(() => write(content))
    .then(
      (): CopyResult => ({ copied: true }),
      (error: unknown): CopyResult => ({
        copied: false,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  try {
    const result = await Promise.race([copying, cancelled]);
    return ownership.isCurrent() && !ownership.signal.aborted ? result : CANCELLED;
  } finally {
    if (onAbort) ownership.signal.removeEventListener("abort", onAbort);
  }
}

export async function insertIntoEditor(
  ctx: ExtensionCommandContext,
  content: string,
  ownership: ActionOwnership,
): Promise<boolean> {
  if (!ownership.isCurrent()) return false;
  if (ctx.mode === "rpc") {
    const confirmed = await ctx.ui.confirm(
      "Replace client draft with snippet?",
      "RPC cannot read or append to the client draft. This will replace the entire draft with the selected snippet.",
      { signal: ownership.signal },
    );
    if (!ownership.isCurrent() || !confirmed) return false;
    ctx.ui.setEditorText(content);
    return true;
  }
  const existing = ctx.ui.getEditorText();
  const next = existing ? `${existing}\n${content}` : content;
  ctx.ui.setEditorText(next);
  return true;
}

function formatOutput(command: string, result: { stdout: string; stderr: string; code: number }): string {
  const lines: string[] = [];
  lines.push(`Command: ${command}`);
  lines.push(`Exit code: ${result.code}`);

  if (result.stdout.trim().length > 0) {
    lines.push("");
    lines.push("STDOUT:");
    lines.push(result.stdout.trimEnd());
  }

  if (result.stderr.trim().length > 0) {
    lines.push("");
    lines.push("STDERR:");
    lines.push(result.stderr.trimEnd());
  }

  return lines.join("\n");
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const truncated = lines.slice(0, maxLines).join("\n");
  return `${truncated}\n\n[Output truncated to ${maxLines} lines]`;
}

export async function runSnippet(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  snippet: string,
  ownership: ActionOwnership,
  cwd?: string,
): Promise<void> {
  if (!ownership.isCurrent() || ownership.signal.aborted) return;
  const capturedCwd = cwd ?? ctx.cwd;
  const isWindows = process.platform === "win32";
  const command = isWindows ? "powershell" : "bash";
  const args = isWindows ? ["-NoProfile", "-Command", snippet] : ["-lc", snippet];

  const result = await executeSnippet(command, args, capturedCwd, ownership);
  if (!ownership.isCurrent() || ownership.signal.aborted) return;
  const output = truncateLines(formatOutput(`${command} ${args.join(" ")}`, result), 200);

  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(output, result.code === 0 ? "info" : "error");
    return;
  }

  await ownedCustom<void>(ctx, ownership, (_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Command Output")), 1, 0));

    const text = new Text(output, 1, 0);
    container.addChild(text);

    container.addChild(new Text(theme.fg("dim", "Enter/Esc to close"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

    return {
      render: (width: number) => container.render(width).map((line) => truncateToWidth(line, width)),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
          done();
        }
      },
    };
  });
}

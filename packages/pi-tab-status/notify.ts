/**
 * Opt-in desktop notifications written as terminal escape sequences.
 *
 * Adapted from `ferologics/pi-notify` and Pi's `examples/extensions/notify.ts`
 * (both MIT); the README's Provenance section records how this diverges.
 */

import { sanitizeTitleText } from "./terminal-text.js";

export type NotifyProtocol = "osc777" | "osc9" | "osc99";

type Environment = Record<string, string | undefined>;

const MAX_NOTIFICATION_TEXT = 160;

/**
 * Read on each call, like `PI_TAB_STATUS_STYLE`. `1` picks the protocol from the
 * terminal's environment; a protocol name forces it where that heuristic
 * misreads the terminal, for example inside tmux, where `TERM_PROGRAM` names
 * tmux rather than the outer terminal. Any other value, including unset, keeps
 * notifications off.
 */
export function resolveNotifyProtocol(env: Environment = process.env): NotifyProtocol | undefined {
  const setting = env.PI_TAB_STATUS_NOTIFY;
  if (setting === "osc777" || setting === "osc9" || setting === "osc99") return setting;
  if (setting !== "1") return undefined;
  if (env.KITTY_WINDOW_ID) return "osc99";
  if (env.TERM_PROGRAM === "iTerm.app" || env.ITERM_SESSION_ID || env.LC_TERMINAL === "iTerm2") return "osc9";
  return "osc777";
}

/**
 * `;` separates OSC 777 fields and introduces OSC 9 subcommands, so a literal
 * one would shift the body into another field or be read as a command.
 */
export function sanitizeNotificationText(value: string): string {
  const safe = sanitizeTitleText(value.replaceAll(";", ","));
  return [...safe].slice(0, MAX_NOTIFICATION_TEXT).join("").trimEnd();
}

/** tmux drops unknown OSC sequences unless they arrive in its DCS passthrough, with every inner ESC doubled. */
export function wrapForTmux(sequence: string, env: Environment = process.env): string {
  if (!env.TMUX) return sequence;
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

export function formatNotification(
  protocol: NotifyProtocol,
  title: string,
  body: string,
  env: Environment = process.env,
): string {
  const safeTitle = sanitizeNotificationText(title);
  const safeBody = sanitizeNotificationText(body);
  const sequences =
    protocol === "osc99"
      ? // Kitty: the first chunk carries the title and stays open (d=0); the body chunk completes it.
        [`\x1b]99;i=1:d=0;${safeTitle}\x1b\\`, `\x1b]99;i=1:p=body;${safeBody}\x1b\\`]
      : protocol === "osc9"
        ? [`\x1b]9;${safeTitle}: ${safeBody}\x07`]
        : [`\x1b]777;notify;${safeTitle};${safeBody}\x07`];
  return sequences.map((sequence) => wrapForTmux(sequence, env)).join("");
}

/**
 * Pi's own terminal writes its escapes to the same stream. A notification
 * neither moves the cursor nor draws, and a synchronous write cannot land inside
 * a rendered frame, so it leaves the screen intact.
 */
export function sendDesktopNotification(title: string, body: string, env: Environment = process.env): void {
  const protocol = resolveNotifyProtocol(env);
  if (protocol === undefined) return;
  try {
    process.stdout.write(formatNotification(protocol, title, body, env));
  } catch {
    // A closed terminal must not throw into the host's lifecycle dispatch.
  }
}

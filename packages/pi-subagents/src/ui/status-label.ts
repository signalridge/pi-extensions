/** Shared text labels, marks, and colors for agent lifecycle statuses. */

export type AgentStatusColor = "accent" | "dim" | "warning" | "error";

/**
 * Leading mark for an agent row, colored by `getAgentStatusColor`.
 *
 * U+25CF rather than one of the emoji circles: an emoji code point invites font
 * fallback, and a fallback glyph is usually double-width, which would push the
 * rest of the row out of its column on some terminals and not others. Every
 * mark here is a single column, so the label after it starts at the same place
 * whatever the status — and stays there when the status changes mid-run.
 */
export function getAgentStatusMark(status: string): string {
  switch (status) {
    case "error":
      return "✗";
    // Both are a run the user or the runtime stopped, as opposed to one that
    // failed on its own; the slashed circle says "called off", not "broke".
    case "aborted":
    case "stopped":
      return "⊘";
    default:
      return "●";
  }
}

/** Return the user-facing lifecycle label without collapsing distinct outcomes. */
export function getAgentStatusLabel(status: string): string {
  switch (status) {
    case "error":
      return "failed";
    case "steered":
      return "wrapped up · turn limit";
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "queued":
      return "queued";
    case "aborted":
      return "aborted";
    case "stopped":
      return "stopped";
    default:
      return status;
  }
}

/** Return the restrained semantic color for a lifecycle status. */
export function getAgentStatusColor(status: string): AgentStatusColor {
  switch (status) {
    case "error":
      return "error";
    case "steered":
    case "aborted":
      return "warning";
    case "running":
      return "accent";
    default:
      return "dim";
  }
}

/**
 * arming.ts — the keyword that authorizes the workflow tool for a turn.
 *
 * Typing the bounded word `workflow` (or `workflows`, or a configured synonym)
 * in an ordinary message is an explicit opt-in to multi-agent orchestration, so
 * the message is annotated to tell the model the tool is available for this
 * turn. Two properties matter, and both are easy to get wrong:
 *
 *  1. **Arming authorizes; it does not compel.** The directive says the model
 *     MAY run a workflow and may still decline, so "how do workflows work?"
 *     stays an ordinary question with an ordinary answer. A trigger that forced
 *     a run would make the word unusable in conversation.
 *
 *  2. **Only a real word counts.** A workflow is something people also write
 *     code about, so `myworkflow`, `workflow_name`, `src/workflow-editor.ts`,
 *     `workflow.ts`, and `--workflow-id` must not arm anything. A bare `\b`
 *     boundary is not enough: it treats `-`, `/`, and `.` as separators, so it
 *     matches inside every one of those but the identifier.
 */

/** The word that arms the tool when no synonym is configured. */
export const DEFAULT_TRIGGER_WORD = "workflow";

/**
 * Appended to an armed message. Phrased as permission with an explicit escape
 * hatch: the model is told the user opted in, and told it may still answer
 * directly when a workflow would be overkill.
 */
export const WORKFLOW_ARMED_DIRECTIVE =
  "<system-reminder>You typed the workflow trigger word, which counts as an explicit opt-in to multi-agent orchestration: the `workflow` tool is authorized for this turn. It runs in the background by default — the turn ends and the result is delivered back into the conversation when it finishes, which is expected rather than a stall, so you need not stay and block. Pass background:false only when the user is waiting for the result inline. This is permission, not an instruction: if the request is conversational, trivial, or better answered directly, answer it directly and do not run a workflow.</system-reminder>";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Token boundaries that treat identifier, path, and flag punctuation as PART of
 * the token rather than as a separator. `\p{ID_Continue}` covers letters,
 * digits and `_`; `/`, `-` and `$` are added so paths, kebab-case identifiers,
 * and flags are each one token.
 *
 * A trailing `.` is the one case that cannot be decided by the character alone:
 * `workflow.ts` is a filename, but `a workflow.` is a sentence, and ending a
 * sentence with the word is far too common to refuse. So a following dot blocks
 * the match only when something continues the token after it — the second
 * lookahead below. A LEADING dot stays disqualifying (`.workflow` reads as a
 * dotfile or a property access, never as prose).
 */
function triggerRegex(word: string): RegExp {
  const escaped = escapeRegExp(word);
  // The default word is the only one that also matches its plural: a configured
  // synonym is matched exactly as the user spelled it.
  const plural = word === DEFAULT_TRIGGER_WORD ? "s?" : "";
  return new RegExp(
    `(?<![/.$\\-\\p{ID_Continue}])${escaped}${plural}(?![/$\\-\\p{ID_Continue}])(?!\\.\\p{ID_Continue})`,
    "iu",
  );
}

/**
 * Whether `text` contains the trigger word as a standalone word.
 *
 * Arms:      "run a workflow", "workflows, please", "use the WORKFLOW tool"
 * Does not:  "myworkflow", "workflow_name", "src/workflow-editor.ts",
 *            "workflow.ts", "--workflow-id", "/workflows" (a slash command)
 */
export function hasTriggerWord(text: string, configuredWord?: string): boolean {
  return triggerRegex(configuredWord ?? DEFAULT_TRIGGER_WORD).test(text);
}

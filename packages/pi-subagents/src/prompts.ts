/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig, EnvInfo } from "./types.js";

/** Extra sections to inject into the system prompt (memory, skills, etc.). */
export interface PromptExtras {
  /** Persistent memory content to inject (first 200 lines of MEMORY.md + instructions). */
  memoryBlock?: string;
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string }[];
  /** Original repository top-level the worktree copy came from; used to protect the base repo. */
  worktreeBase?: string;
}

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: env header + config.systemPrompt (full control, no parent identity)
 * - "append" mode: parent system prompt + sub-agent context + env header + config.systemPrompt
 * - "append" with empty systemPrompt: pure parent clone
 *
 * Both modes include an `<active_agent name="${config.name}"/>` tag so downstream
 * extensions (e.g. permission/policy systems) can resolve per-agent policy
 * inside the child session by parsing the system prompt. In replace mode the tag
 * is prepended; in append mode it follows the shared inherited content so the
 * parent prompt forms an identical, cacheable byte prefix with the parent
 * session (the LLM's KV cache can then reuse those tokens across every spawn).
 *
 * @param parentSystemPrompt  The parent agent's effective system prompt (for append mode).
 * @param extras  Optional extra sections to inject (memory, preloaded skills).
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;


  // The inherited parent prompt may name the base checkout as its cwd. Keep the
  // isolation guidance after that cacheable prefix and the environment block so
  // the child follows the writable copy instead.
  const worktreeBlock = extras?.worktreeBase
    ? `<worktree_isolation>
Your working directory is a writable isolated git worktree copy of ${extras.worktreeBase}.
Work only inside the copy — the base checkout at ${extras.worktreeBase} is off-limits, even if other instructions name it as your working directory.
</worktree_isolation>`
    : "";

  // Build optional extras suffix
  const extraSections: string[] = [];
  if (extras?.memoryBlock) {
    extraSections.push(extras.memoryBlock);
  }
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }
  const extrasSuffix = extraSections.length > 0 ? "\n\n" + extraSections.join("\n") : "";

  if (config.promptMode === "append") {
    const identity = parentSystemPrompt || genericBase;

    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

    const customSection = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";

    // Place shared/stable content first so the LLM's KV cache can reuse the
    // inherited prefix across all subagent invocations. The parent prompt is
    // placed verbatim (no wrapper tag) so it forms an identical byte prefix
    // with the parent session, maximising KV cache hits. The <active_agent>
    // tag and env block vary per call and are placed after the cached prefix.
    return identity + "\n\n" + bridge + "\n\n" + activeAgentTag + envBlock + (worktreeBlock ? `\n\n${worktreeBlock}` : "") + customSection + extrasSuffix;
  }

  // "replace" mode — env header + the config's full system prompt
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return activeAgentTag + replaceHeader + (worktreeBlock ? `\n\n${worktreeBlock}` : "") + "\n\n" + config.systemPrompt + extrasSuffix;
}

/**
 * The part of the parent's rendered system prompt an append-mode child inherits.
 *
 * Pi 1.4 renders the preamble followed by tagged sections in a fixed order:
 * `tools`, `rules`, `docs` (default preamble only), `addendum`,
 * `project_context`, `skills`, `cwd`, then sections extensions add during a
 * turn. The child loads no context files or addendum of its own, so it keeps
 * those, but its session renders its own `skills` (per its `skills:` setting),
 * its own `cwd` and its own extension sections after the inherited text.
 * Inheriting the parent's copies listed skills twice, showed the parent's
 * skills to `skills: false` or preload-list agents, named the parent's cwd to
 * a child running elsewhere, and depended on timing: `getSystemPrompt()`
 * includes extension sections only while the parent's turn runs.
 *
 * Returns the text before the `skills` section, or before the `cwd` section
 * when there are no skills. A prompt without the parent's `cwd` section (a
 * forced prompt, for example) is returned unchanged.
 *
 * @param rendered  The parent's `ctx.getSystemPrompt()`.
 * @param cwd  The cwd the parent's prompt was rendered with.
 */
export function inheritableParentPrompt(rendered: string, cwd: string): string {
  const cwdAt = rendered.lastIndexOf(`\n\n<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`);
  if (cwdAt < 0) return rendered;
  const head = rendered.slice(0, cwdAt);
  if (!head.endsWith("\n</skills>")) return head;
  const skillsAt = head.lastIndexOf("\n\n<skills>\n");
  return skillsAt < 0 ? head : head.slice(0, skillsAt);
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;

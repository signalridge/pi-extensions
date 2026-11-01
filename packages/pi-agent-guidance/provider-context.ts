/**
 * Provider-specific guidance in the system prompt: CLAUDE.md, CODEX.md or
 * GEMINI.md from the agent directory and the working directory's ancestors.
 */

import * as path from "node:path";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type Config,
  type ContextFile,
  getCandidateFiles,
  getDirectories,
  legacyContextFiles,
  readContextFile,
  shouldLoad,
} from "./selection.js";

export interface ProviderContext {
  /** Every context file this run's system prompt carries: the host's selection, then provider guidance. */
  loaded: readonly ContextFile[];
  result?: BeforeAgentStartEventResult;
}

export function applyProviderContext(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  config: Config,
  agentDir: string,
): ProviderContext {
  const directories = getDirectories(ctx.cwd, agentDir);
  const contextFiles = event.systemPromptOptions?.contextFiles ?? legacyContextFiles(directories);
  const provider = ctx.model?.provider;
  const candidates = provider ? getCandidateFiles(ctx.model?.id, provider, config) : [];
  const files: ContextFile[] = [];

  for (const dir of directories) {
    for (const filename of candidates) {
      const file = readContextFile(path.join(dir, filename));
      if (file && shouldLoad(file, [...contextFiles, ...files])) files.push(file);
    }
  }

  const loaded = [...contextFiles, ...files];
  if (files.length === 0) return { loaded };

  const options = event.systemPromptOptions;
  const section = "provider_context";
  const existing = options?.sections?.[section] ?? "";
  const additions = files
    .map(({ path: p, content }) => `## ${p}\n\n${content}\n\n`)
    .filter((text) => !(options ? existing : event.systemPrompt).includes(text));
  if (additions.length === 0) return { loaded };
  const append = `${existing ? "" : "# Provider-Specific Context\n\n"}${additions.join("")}`;

  if (!options) return { loaded, result: { systemPrompt: `${event.systemPrompt}\n\n${append}` } };
  // Mutate only our section. Rendering the whole prompt here would force an
  // opaque replacement, hiding later policy, context, and tool mutations.
  options.sections ??= {};
  options.sections[section] = `${existing}${existing && !existing.endsWith("\n\n") ? "\n\n" : ""}${append}`;
  // Respect a full replacement intentionally installed by an earlier handler.
  // Structured hosts without a forced prompt remain entirely structured.
  if (options.forceSystemPrompt !== undefined && !options.forceSystemPrompt.includes(append)) {
    options.forceSystemPrompt += `\n\n${append}`;
  }
  return { loaded };
}

import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeAgentIn(projectDir: ".agents" | ".pi", name: string, content: string) {
    const dir = join(tmpDir, projectDir, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  function writeAgent(name: string, content: string) {
    writeAgentIn(".pi", name, content);
  }

  function writeWorkspaceAgent(name: string, content: string) {
    writeAgentIn(".agents", name, content);
  }

  it("returns empty map when custom agent dirs do not exist", () => {
    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads a workspace project agent from .agents/agents", () => {
    writeWorkspaceAgent("reviewer", `---
description: Workspace Reviewer
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("reviewer")?.description).toBe("Workspace Reviewer");
    expect(result.get("reviewer")?.systemPrompt).toBe("Workspace prompt.");
    expect(result.get("reviewer")?.source).toBe("project");
  });

  it(".pi/agents overrides .agents/agents on a name clash", () => {
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);
    writeAgent("dupe", `---
description: Pi Project
---

Pi prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Pi Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Pi prompt.");
  });

  it("workspace project agents override global agents", () => {
    const globalAgentDir = join(tmpDir, "global-agent-dir");
    process.env.PI_CODING_AGENT_DIR = globalAgentDir;
    const globalAgents = join(globalAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    writeFileSync(join(globalAgents, "dupe.md"), `---
description: Global
---

Global prompt.`);
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Workspace Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Workspace prompt.");
  });

  it("loads a basic agent with all frontmatter fields", () => {
    writeAgent("auditor", `---
description: Security Auditor
tools: read, grep, find
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
persist_session: true
output_transcript: false
session_dir: .seams/pi-sessions/seam-plan-reviewer
allowed_subagents: scout, reviewer
prompt_mode: replace
inherit_context: true
run_in_background: true
isolated: true
---

You are a security auditor.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);

    const agent = result.get("auditor")!;
    expect(agent.name).toBe("auditor");
    expect(agent.description).toBe("Security Auditor");
    expect(agent.builtinToolNames).toEqual(["read", "grep", "find"]);
    // Which model an agent runs is the tier catalogue's decision; a per-file
    // pin is read as documentation of an unfinished migration, nothing more.
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBe(30);
    expect(agent.persistSession).toBe(true);
    expect(agent.outputTranscript).toBe(false);
    expect(agent.sessionDir).toBe(".seams/pi-sessions/seam-plan-reviewer");
    expect(agent.allowedSubagents).toEqual(["scout", "reviewer"]);
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBe(true);
    expect(agent.runInBackground).toBe(true);
    expect(agent.isolated).toBe(true);
    expect(agent.systemPrompt).toBe("You are a security auditor.");
  });

  it("uses sensible defaults when frontmatter is empty", () => {
    writeAgent("minimal", `---
---

Just a prompt.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("minimal")!;

    expect(agent.name).toBe("minimal");
    expect(agent.description).toBe("minimal"); // defaults to filename
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES); // all tools
    expect(agent.extensions).toBe(true); // inherit all
    expect(agent.skills).toBe(true); // inherit all
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.persistSession).toBeUndefined();
    expect(agent.outputTranscript).toBeUndefined();
    expect(agent.sessionDir).toBeUndefined();
    expect(agent.allowedSubagents).toBeUndefined();
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBeUndefined();
    expect(agent.runInBackground).toBeUndefined();
    expect(agent.isolated).toBeUndefined();
    expect(agent.systemPrompt).toBe("Just a prompt.");
  });

  it("uses sensible defaults when no frontmatter at all", () => {
    writeAgent("bare", "Just a system prompt, no frontmatter.");

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("bare")!;

    expect(agent.name).toBe("bare");
    expect(agent.description).toBe("bare");
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
  });

  it("parses allowed_subagents: off by default, `all` wildcard, csv restriction", () => {
    writeAgent("omitted", `---
---
Off.`);
    writeAgent("unrestricted", `---
allowed_subagents: all
---
Unrestricted.`);
    writeAgent("wildcard", `---
allowed_subagents: "*"
---
Unrestricted.`);
    writeAgent("mixed-case", `---
allowed_subagents: scout, ALL
---
Unrestricted.`);
    writeAgent("none", `---
allowed_subagents: none
---
Off.`);
    writeAgent("blank", `---
allowed_subagents:
---
Off.`);
    writeAgent("restricted", `---
allowed_subagents: scout, reviewer
---
Restricted.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("omitted")!.allowedSubagents).toBeUndefined();
    expect(result.get("unrestricted")!.allowedSubagents).toBe("all");
    expect(result.get("wildcard")!.allowedSubagents).toBe("all");
    expect(result.get("mixed-case")!.allowedSubagents).toBe("all");
    expect(result.get("none")!.allowedSubagents).toBeUndefined();
    expect(result.get("blank")!.allowedSubagents).toBeUndefined();
    expect(result.get("restricted")!.allowedSubagents).toEqual(["scout", "reviewer"]);
  });

  it("accepts booleans like extensions:/skills: do, instead of a type named \"true\"", () => {
    writeAgent("bool-on", `---
allowed_subagents: true
---
On.`);
    writeAgent("bool-off", `---
allowed_subagents: false
---
Off.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bool-on")!.allowedSubagents).toBe("all");
    expect(result.get("bool-off")!.allowedSubagents).toBeUndefined();
  });

  it("handles tools: none → empty array", () => {
    writeAgent("notool", `---
tools: none
---

No tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("notool")!.builtinToolNames).toEqual([]);
  });

  it("handles extensions: false → no extensions", () => {
    writeAgent("noext", `---
extensions: false
skills: false
---

No extensions.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("noext")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("handles extension allowlist", () => {
    writeAgent("partial", `---
extensions: web-search, mcp-server
skills: planning, review
---

Partial access.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("partial")!;
    expect(agent.extensions).toEqual(["web-search", "mcp-server"]);
    expect(agent.skills).toEqual(["planning", "review"]);
  });

  it("parses exclude_extensions CSV", () => {
    writeAgent("no-notify", `---
extensions: true
exclude_extensions: pi-notify, telemetry
---

No notifications.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("no-notify")!;
    expect(agent.extensions).toBe(true);
    expect(agent.excludeExtensions).toEqual(["pi-notify", "telemetry"]);
  });

  it("parses exclude_extensions YAML list", () => {
    writeAgent("no-notify-yaml", `---
exclude_extensions:
  - pi-notify
---

No notifications.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-notify-yaml")!.excludeExtensions).toEqual(["pi-notify"]);
  });

  it("exclude_extensions omitted or none → undefined", () => {
    writeAgent("plain", `---
description: plain
---

Plain.`);
    writeAgent("explicit-none", `---
exclude_extensions: none
---

None.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("plain")!.excludeExtensions).toBeUndefined();
    expect(result.get("explicit-none")!.excludeExtensions).toBeUndefined();
  });

  it("passes through unknown tool names (not filtered)", () => {
    writeAgent("custom-tools", `---
tools: read, my_custom_tool, grep
---

Custom tools.`);

    const result = loadCustomAgents(tmpDir);
    // Unknown tool names are passed through — filtering happens at tool creation time
    expect(result.get("custom-tools")!.builtinToolNames).toEqual(["read", "my_custom_tool", "grep"]);
  });

  it("partitions tools: ext: entries out of builtinToolNames into extSelectors", () => {
    writeAgent("ext-agent", `---
tools: read, ext:foo, ext:bar/x
---

Extension selectors.`);

    const agent = loadCustomAgents(tmpDir).get("ext-agent")!;
    expect(agent.builtinToolNames).toEqual(["read"]);
    expect(agent.extSelectors).toEqual(["ext:foo", "ext:bar/x"]);
  });

  it("tools: with only ext: entries yields zero built-ins", () => {
    writeAgent("ext-only", `---
tools: ext:foo/bar
---

Ext only.`);

    const agent = loadCustomAgents(tmpDir).get("ext-only")!;
    expect(agent.builtinToolNames).toEqual([]);
    expect(agent.extSelectors).toEqual(["ext:foo/bar"]);
  });

  it("tools: '*' expands to all built-ins and composes with ext: selectors", () => {
    writeAgent("wild", `---
tools: "*, ext:foo"
---

Wildcard plus ext.`);

    const agent = loadCustomAgents(tmpDir).get("wild")!;
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.extSelectors).toEqual(["ext:foo"]);
  });

  it("tools: 'all' is a case-insensitive alias for '*' (closes #75)", () => {
    // `tools: all` previously parsed "all" as a single tool name → allowlist
    // containing the non-existent tool "all" → silent zero-tool agent.
    for (const [name, value] of [["all-lower", "all"], ["all-upper", "ALL"], ["all-mixed", "All"]]) {
      writeAgent(name, `---\ntools: ${value}\n---\n\nAlias.`);
      const agent = loadCustomAgents(tmpDir).get(name)!;
      expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
      expect(agent.extSelectors).toBeUndefined();
    }
  });

  it("tools: 'all' composes with ext: selectors like '*'", () => {
    writeAgent("all-plus-ext", `---
tools: "all, ext:foo"
---

All plus ext.`);

    const agent = loadCustomAgents(tmpDir).get("all-plus-ext")!;
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.extSelectors).toEqual(["ext:foo"]);
  });

  it("leaves extSelectors undefined when tools: has no ext: entries", () => {
    writeAgent("plain", `---
tools: read, bash
---

Plain tools.`);

    const agent = loadCustomAgents(tmpDir).get("plain")!;
    expect(agent.builtinToolNames).toEqual(["read", "bash"]);
    expect(agent.extSelectors).toBeUndefined();
  });

  it("ignores a legacy model/thinking pin, keeping the rest of the agent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeAgent("pinned", `---
description: Still usable
model: anthropic/claude-opus-4-6
thinking: max
---

Body.`);

    try {
      const agent = loadCustomAgents(tmpDir).get("pinned")!;

      // The file still loads — a stale pin is a migration its author has not
      // done, not a reason to take the agent away mid-session.
      expect(agent.description).toBe("Still usable");
      expect(agent.systemPrompt).toBe("Body.");
      expect(agent.model).toBeUndefined();
      expect(agent.thinking).toBeUndefined();
      expect(warn.mock.calls.map(String).join("\n")).toMatch(/Ignoring model and thinking .*pinned\.md/);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads the tier an agent asks for, and drops one that is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeAgent("tiered", "---\ntier: research\n---\n\nBody.");
    writeAgent("bad", "---\ntier: two words\n---\n\nBody.");

    try {
      const result = loadCustomAgents(tmpDir);
      expect(result.get("tiered")!.agentTier).toBe("research");
      // Shape only — whether the key names a real profile is decided against
      // the catalogue, which may legitimately change after this file was read.
      expect(result.get("bad")!.agentTier).toBeUndefined();
      expect(warn.mock.calls.map(String).join("\n")).toMatch(/invalid tier/);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts max_turns: 0 as unlimited", () => {
    writeAgent("unlimited", `---
max_turns: 0
---

Unlimited turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unlimited")!.maxTurns).toBe(0);
  });

  it("rejects negative max_turns", () => {
    writeAgent("negturns", `---
max_turns: -5
---

Negative turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("negturns")!.maxTurns).toBeUndefined();
  });

  it("handles prompt_mode: append", () => {
    writeAgent("appender", `---
prompt_mode: append
---

Extra instructions.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("appender")!.promptMode).toBe("append");
  });

  it("defaults unknown prompt_mode to replace", () => {
    writeAgent("badmode", `---
prompt_mode: merge
---

Unknown mode.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("badmode")!.promptMode).toBe("replace");
  });

  it("loads multiple agents", () => {
    writeAgent("agent1", `---
description: First
---

First agent.`);
    writeAgent("agent2", `---
description: Second
---

Second agent.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(2);
    expect(result.has("agent1")).toBe(true);
    expect(result.has("agent2")).toBe(true);
  });

  it("skips non-.md files", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    writeFileSync(join(dir, "real.md"), `---
description: Real Agent
---

Real.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("real")).toBe(true);
  });

  it("allows agents with names matching defaults (overrides them)", () => {
    writeAgent("Explore", `---
description: Custom Explore
---

Custom explore agent.`);
    writeAgent("custom", `---
description: Custom Agent
---

Should be loaded.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.has("Explore")).toBe(true);
    expect(result.get("Explore")!.description).toBe("Custom Explore");
    expect(result.has("custom")).toBe(true);
  });

  it("handles empty body with frontmatter", () => {
    writeAgent("nobody", `---
description: No body
tools: read
---
`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("nobody")!.systemPrompt).toBe("");
  });

  it("supports inherit_extensions as alternative to extensions", () => {
    writeAgent("altkey", `---
inherit_extensions: false
inherit_skills: false
---

Alt keys.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("altkey")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: none → false", () => {
    writeAgent("extnone", `---
extensions: none
skills: none
---

None.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("extnone")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: true → true (inherit all)", () => {
    writeAgent("exttrue", `---
extensions: true
skills: true
---

All.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("exttrue")!;
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("handles enabled: false frontmatter", () => {
    writeAgent("disabled", `---
enabled: false
---
`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("disabled")!;
    expect(agent.enabled).toBe(false);
  });

  it("parses display_name frontmatter", () => {
    writeAgent("myagent", `---
description: My Agent
display_name: MyAgent
---

Agent prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("myagent")!.displayName).toBe("MyAgent");
  });

  it("parses disallowed_tools as csv list", () => {
    writeAgent("restricted", `---
description: Restricted Agent
disallowed_tools: bash, write
---

No bash or write.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("restricted")!;
    expect(agent.disallowedTools).toEqual(["bash", "write"]);
  });

  it("disallowed_tools defaults to undefined when omitted", () => {
    writeAgent("unrestricted", `---
description: Unrestricted
---

All tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unrestricted")!.disallowedTools).toBeUndefined();
  });

  it("parses memory scope", () => {
    writeAgent("rememberer", `---
description: Agent with memory
memory: project
---

Remember things.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("rememberer")!.memory).toBe("project");
  });

  it("parses memory: user scope", () => {
    writeAgent("global-mem", `---
memory: user
---

User memory.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("global-mem")!.memory).toBe("user");
  });

  it("memory defaults to undefined when omitted", () => {
    writeAgent("no-mem", `---
description: No memory
---

Stateless.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-mem")!.memory).toBeUndefined();
  });

  it("rejects invalid memory scope", () => {
    writeAgent("bad-mem", `---
memory: invalid
---

Bad memory.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bad-mem")!.memory).toBeUndefined();
  });

  it("parses isolation: worktree", () => {
    writeAgent("isolated-wt", `---
description: Worktree agent
isolation: worktree
---

Isolated.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("isolated-wt")!.isolation).toBe("worktree");
  });

  it("isolation defaults to undefined when omitted", () => {
    writeAgent("no-isolation", `---
description: Normal
---

Normal.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-isolation")!.isolation).toBeUndefined();
  });

  it("rejects invalid isolation mode", () => {
    writeAgent("bad-isolation", `---
isolation: docker
---

Bad isolation.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bad-isolation")!.isolation).toBeUndefined();
  });

  it("warns when a malformed override falls back to an embedded default and suppresses unchanged warnings per cached root", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeAgent("general-purpose", "---\ndescription: [unterminated\n---\n\nBroken override.");

    const first = loadCustomAgents(tmpDir);
    expect(first.has("general-purpose")).toBe(false);
    expect(warnings.mock.calls.some(([message]) => message.includes("embedded default \"general-purpose\""))).toBe(true);
    const firstCount = warnings.mock.calls.length;

    loadCustomAgents(tmpDir);
    expect(warnings.mock.calls.length).toBe(firstCount);

    const otherRoot = mkdtempSync(join(tmpdir(), "pi-warning-root-"));
    try {
      mkdirSync(join(otherRoot, ".pi", "agents"), { recursive: true });
      writeFileSync(join(otherRoot, ".pi", "agents", "general-purpose.md"), "---\ndescription: [unterminated\n---\n\nBroken override.");
      loadCustomAgents(otherRoot);
      expect(warnings.mock.calls.length).toBeGreaterThan(firstCount);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("suppresses unchanged warnings only while the root remains in the bounded LRU", () => {
    writeAgent("broken", "---\ndescription: [broken\n---\n\nBroken.");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    loadCustomAgents(tmpDir);
    const firstCount = warnings.mock.calls.length;
    loadCustomAgents(tmpDir);
    expect(warnings.mock.calls.length).toBe(firstCount);

    const roots: string[] = [];
    const loadBrokenRoot = (prefix: string, index: number): void => {
      const root = mkdtempSync(join(tmpdir(), `${prefix}-${index}-`));
      roots.push(root);
      const agentsDir = join(root, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, "broken.md"), "---\ndescription: [broken\n---\n\nBroken.");
      loadCustomAgents(root);
    };
    try {
      // Keep the original root in the 64-entry cache while 62 other roots are visited.
      for (let index = 0; index < 62; index++) loadBrokenRoot("pi-warning-cache", index);
      expect(warnings.mock.calls.length).toBe(firstCount + 62);
      loadCustomAgents(tmpDir);
      expect(warnings.mock.calls.length).toBe(firstCount + 62);

      // After the check above, 64 more roots fill the bounded cache and evict it.
      for (let index = 0; index < 64; index++) loadBrokenRoot("pi-warning-cache-evict", index);
      expect(warnings.mock.calls.length).toBe(firstCount + 126);
      loadCustomAgents(tmpDir);
      expect(warnings.mock.calls.length).toBe(firstCount + 127);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("throws the enumerated directory path in strict mode", () => {
    const projectAgentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(projectAgentsDir, "not a directory");

    expect(() => loadCustomAgents(tmpDir, true)).toThrow(`${projectAgentsDir}: ENOTDIR`);
  });

  it("warns once and continues when an agent directory cannot be enumerated", () => {
    const projectAgentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(projectAgentsDir, "not a directory");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadCustomAgents(tmpDir).size).toBe(0);
    const firstCount = warnings.mock.calls.length;
    expect(firstCount).toBe(1);
    expect(loadCustomAgents(tmpDir).size).toBe(0);
    expect(warnings.mock.calls.length).toBe(firstCount);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Skipping agent directory"));
  });

  it("deduplicates exact global/project directory aliases and re-warns after fix-then-break", () => {
    const aliasDir = join(tmpDir, ".pi");
    const aliasedAgentsDir = join(aliasDir, "agents");
    process.env.PI_CODING_AGENT_DIR = aliasDir;
    mkdirSync(aliasDir, { recursive: true });
    writeFileSync(aliasedAgentsDir, "not a directory");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadCustomAgents(tmpDir).size).toBe(0);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining(`${aliasedAgentsDir}: ENOTDIR`));
    expect(() => loadCustomAgents(tmpDir, true)).toThrow(`${aliasedAgentsDir}: ENOTDIR`);

    rmSync(aliasedAgentsDir, { force: true });
    mkdirSync(aliasedAgentsDir);
    expect(loadCustomAgents(tmpDir).size).toBe(0);
    expect(warnings).toHaveBeenCalledTimes(1);

    rmSync(aliasedAgentsDir, { recursive: true, force: true });
    writeFileSync(aliasedAgentsDir, "broken again");
    expect(loadCustomAgents(tmpDir).size).toBe(0);
    expect(warnings).toHaveBeenCalledTimes(2);
  });

  it("deduplicates warnings for distinct paths that share a file inode and re-warns after fix-then-break", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const globalAgentDir = join(tmpDir, "global-agent-dir");
    const globalAgents = join(globalAgentDir, "agents");
    const projectAgents = join(tmpDir, ".pi", "agents");
    const sharedSource = join(tmpDir, "shared-agent.md");
    process.env.PI_CODING_AGENT_DIR = globalAgentDir;
    mkdirSync(globalAgents, { recursive: true });
    mkdirSync(projectAgents, { recursive: true });
    writeFileSync(sharedSource, "---\ndescription: [unterminated\n---\n\nBroken.");
    linkSync(sharedSource, join(globalAgents, "same.md"));
    linkSync(sharedSource, join(projectAgents, "same.md"));

    loadCustomAgents(tmpDir);
    expect(warnings.mock.calls.filter(([message]) => message.includes("Skipping agent file"))).toHaveLength(1);
    const firstCount = warnings.mock.calls.length;

    loadCustomAgents(tmpDir);
    expect(warnings.mock.calls.length).toBe(firstCount);

    writeFileSync(sharedSource, "---\ndescription: Fixed\n---\n\nFixed.");
    expect(loadCustomAgents(tmpDir).get("same")?.description).toBe("Fixed");
    expect(warnings.mock.calls.length).toBe(firstCount);

    writeFileSync(sharedSource, "---\ndescription: [unterminated\n---\n\nBroken again.");
    loadCustomAgents(tmpDir);
    expect(warnings.mock.calls.filter(([message]) => message.includes("Skipping agent file"))).toHaveLength(2);
  });

  it("deduplicates case aliases by inode when the filesystem resolves them", () => {
    const aliasRoot = tmpDir.toUpperCase();
    let rootStats: ReturnType<typeof statSync>;
    let aliasStats: ReturnType<typeof statSync>;
    try {
      rootStats = statSync(tmpDir);
      aliasStats = statSync(aliasRoot);
    } catch {
      return;
    }
    if (rootStats.dev !== aliasStats.dev || rootStats.ino !== aliasStats.ino) return;

    const aliasDir = join(aliasRoot, ".pi");
    const aliasedAgentsDir = join(aliasDir, "agents");
    process.env.PI_CODING_AGENT_DIR = aliasDir;
    mkdirSync(aliasDir, { recursive: true });
    writeFileSync(aliasedAgentsDir, "not a directory");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    loadCustomAgents(tmpDir);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining(`${aliasedAgentsDir}: ENOTDIR`));

    rmSync(aliasedAgentsDir, { force: true });
    mkdirSync(aliasedAgentsDir);
    loadCustomAgents(tmpDir);
    expect(warnings).toHaveBeenCalledTimes(1);

    rmSync(aliasedAgentsDir, { recursive: true, force: true });
    writeFileSync(aliasedAgentsDir, "broken again");
    loadCustomAgents(tmpDir);
    expect(warnings).toHaveBeenCalledTimes(2);
  });

  it("identifies the surviving lower-priority file when an override is malformed", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const globalAgentDir = join(tmpDir, "global-agent-dir");
    process.env.PI_CODING_AGENT_DIR = globalAgentDir;
    const globalAgents = join(globalAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    writeFileSync(join(globalAgents, "fallback.md"), "---\ndescription: Global fallback\n---\n\nGlobal body.");
    writeAgent("fallback", "---\ndescription: [unterminated\n---\n\nBroken override.");

    const result = loadCustomAgents(tmpDir);
    expect(result.get("fallback")?.sourcePath).toBe(join(globalAgents, "fallback.md"));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining(`Agent "fallback" now loads from ${join(globalAgents, "fallback.md")} instead`));
  });

  it("does not report a lower malformed file when a higher valid file survives", () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const globalAgentDir = join(tmpDir, "global-agent-dir");
    process.env.PI_CODING_AGENT_DIR = globalAgentDir;
    const globalAgents = join(globalAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    writeFileSync(join(globalAgents, "shadowed.md"), "---\ndescription: [unterminated\n---\n\nBroken global file.");
    writeAgent("shadowed", "---\ndescription: Project file\n---\n\nValid project file.");

    const result = loadCustomAgents(tmpDir);

    expect(result.get("shadowed")?.description).toBe("Project file");
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("Skipping agent file"));
    expect(warnings).not.toHaveBeenCalledWith(expect.stringContaining('Agent "shadowed" now loads from'));
    expect(warnings).not.toHaveBeenCalledWith(expect.stringContaining('Agent "shadowed" now uses embedded default'));
  });

  it("honors PI_CODING_AGENT_DIR for global custom agent discovery", () => {
    const altAgentDir = mkdtempSync(join(tmpdir(), "pi-alt-agent-"));
    const originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = altAgentDir;
    try {
      const globalAgentsDir = join(altAgentDir, "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "via-env.md"),
        "---\ndescription: Discovered via env var\n---\n\nTest body.",
      );

      const result = loadCustomAgents(tmpDir);

      // Agent is found at $PI_CODING_AGENT_DIR/agents, not at $HOME/.pi/agent/agents
      expect(result.has("via-env")).toBe(true);
      expect(result.get("via-env")!.description).toBe("Discovered via env var");
    } finally {
      if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalEnv;
      rmSync(altAgentDir, { recursive: true, force: true });
    }
  });

  // ---- `name:` frontmatter as agent type (Claude Code interop, B1#1) ----

  it("registers an agent under its declared `name:` when it differs from the filename", () => {
    writeAgent("file-named-differently", `---
name: code-reviewer
description: Declared name wins
---

Test body.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.has("code-reviewer")).toBe(true);
    expect(result.has("file-named-differently")).toBe(false);
    expect(result.get("code-reviewer")!.name).toBe("code-reviewer");
    expect(result.get("code-reviewer")!.description).toBe("Declared name wins");
  });

  it("falls back to the filename when `name:` is absent", () => {
    writeAgent("plain-filename", `---
description: No declared name
---

Test body.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.has("plain-filename")).toBe(true);
  });

  it("rejects an empty or whitespace-only `name:` via || (not ??), keeping the filename", () => {
    writeAgent("fallback-name", `---
name: "   "
description: Whitespace name
---

Test body.`);

    const result = loadCustomAgents(tmpDir);
    // `||`, not `??`: `""` and `"   "` are falsy so the filename stands in.
    expect(result.has("fallback-name")).toBe(true);
    expect(result.has("   ")).toBe(false);
  });

  it("skips an agent whose `name:` contains a colon (reserved for plugin scopes)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeAgent("plugin-thing", `---
name: some:plugin
description: Reserved name
---

Test body.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.has("some:plugin")).toBe(false);
    expect(result.has("plugin-thing")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reserved for"));
    warn.mockRestore();
  });

  it("a declared name participates in priority resolution across discovery roots", () => {
    // Workspace file declares `name: shared-reviewer`; project file declares the
    // same name. The project file (higher priority) must win under the declared
    // name, regardless of filenames.
    writeWorkspaceAgent("workspace-file", `---
name: shared-reviewer
description: From workspace
---

Workspace.`);
    writeAgentIn(".pi", "project-file", `---
name: shared-reviewer
description: From project
---

Project.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("shared-reviewer")?.description).toBe("From project");
  });
});

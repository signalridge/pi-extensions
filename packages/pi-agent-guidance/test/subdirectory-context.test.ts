import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  type ToolResultEvent,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "../selection.js";
import {
  createSubdirectoryContext,
  deliveredFiles,
  directoriesBetween,
  MAX_FILE_BYTES,
  MAX_TURN_BYTES,
  SUBDIRECTORY_ENTRY,
} from "../subdirectory-context.js";

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-guidance-subdir-unit-"));
  cwd = join(root, "project");
  mkdirSync(join(cwd, "pkg", "lib"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness(options: { config?: Config; provider?: string; modelId?: string; trusted?: boolean } = {}) {
  const manager = SessionManager.inMemory(cwd);
  const pi = {
    appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
  } as unknown as ExtensionAPI;
  const subdirectories = createSubdirectoryContext(pi, options.config ?? {}, join(root, "agent"));
  subdirectories.observe([]);
  const ctx = {
    cwd,
    model: {
      provider: options.provider ?? "openai",
      id: options.modelId ?? "gpt-test",
    },
    isProjectTrusted: () => options.trusted ?? true,
    sessionManager: manager,
  } as unknown as ExtensionContext;
  let calls = 0;
  /** Run one tool result through the handler and persist the result as Pi would. */
  function tool(toolName: string, input: Record<string, unknown>, extra: Partial<ToolResultEvent> = {}): string[] {
    const toolCallId = `call-${++calls}`;
    const event = {
      type: "tool_result",
      toolCallId,
      toolName,
      input,
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      details: undefined,
      ...extra,
    } as ToolResultEvent;
    const result = subdirectories.onToolResult(event, ctx);
    const content = result?.content ?? event.content;
    manager.appendMessage({
      role: "toolResult",
      toolCallId,
      toolName,
      content,
      isError: false,
      timestamp: Date.now(),
    });
    return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).slice(1);
  }
  return { manager, subdirectories, tool };
}

function write(relative: string, content: string) {
  writeFileSync(join(cwd, relative), content);
}

test("directories between cwd and a target exclude cwd, outside paths and dependency trees", () => {
  for (const dir of [
    join(root, "elsewhere"),
    join(root, "project-sibling"),
    join(cwd, "..project"),
    join(cwd, "pkg", "node_modules", "dep"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  expect(directoriesBetween(cwd, join(cwd, "pkg", "lib", "a.ts"))).toEqual([join(cwd, "pkg"), join(cwd, "pkg", "lib")]);
  expect(directoriesBetween(cwd, join(cwd, "a.ts"))).toEqual([]);
  expect(directoriesBetween(cwd, join(root, "elsewhere", "a.ts"))).toEqual([]);
  expect(directoriesBetween(cwd, join(root, "project-sibling", "a.ts"))).toEqual([]);
  expect(directoriesBetween(cwd, join(cwd, "..project", "a.ts"))).toEqual([join(cwd, "..project")]);
  expect(directoriesBetween(cwd, join(cwd, "pkg", "node_modules", "dep", "a.ts"))).toEqual([join(cwd, "pkg")]);
});

test("the core file and the model's provider file are chosen per directory", () => {
  write("pkg/AGENTS.md", "pkg agents");
  write("pkg/CLAUDE.md", "pkg claude");
  write("pkg/CODEX.md", "pkg codex");
  write("pkg/lib/CLAUDE.md", "lib claude only");
  const anthropic = harness({ provider: "anthropic" }).tool("read", {
    path: "pkg/lib/a.ts",
  });
  expect(anthropic.map((text) => text.split("\n\n")[1])).toEqual(["pkg agents", "pkg claude", "lib claude only"]);
  const mapped = harness({
    config: { models: { "special-*": ["CODEX.md"] } },
    provider: "anthropic",
    modelId: "special-1",
  });
  expect(mapped.tool("read", { path: "pkg/lib/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual([
    "pkg agents",
    "pkg codex",
    "lib claude only",
  ]);
});

test("content already in the system prompt is not delivered again", () => {
  write("pkg/AGENTS.md", "same as the root guidance");
  write("pkg/CODEX.md", "pkg codex");
  const { subdirectories, tool } = harness();
  subdirectories.observe([{ path: join(cwd, "AGENTS.md"), content: "same as the root guidance" }]);
  expect(tool("read", { path: "pkg/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual(["pkg codex"]);
});

test("disabled, untrusted, failed, nested, unrelated and outside calls deliver and record nothing", () => {
  write("pkg/AGENTS.md", "pkg agents");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "AGENTS.md"), "outside agents");
  symlinkSync(join(root, "outside"), join(cwd, "pkg", "escape"));
  const cases: [ReturnType<typeof harness>, string, Record<string, unknown>, Partial<ToolResultEvent>][] = [
    [harness({ config: { subdirectoryContext: false } }), "read", { path: "pkg/a.ts" }, {}],
    [harness({ trusted: false }), "read", { path: "pkg/a.ts" }, {}],
    [harness(), "read", { path: "pkg/a.ts" }, { isError: true }],
    [harness(), "read", { path: "pkg/a.ts" }, { parentToolCallId: "outer" }],
    [harness(), "grep", { path: "pkg/a.ts" }, {}],
    [harness(), "read", { path: join(root, "outside", "a.ts") }, {}],
    [harness(), "read", { path: "pkg/escape/a.ts" }, {}],
  ];
  for (const [subject, toolName, input, extra] of cases) {
    expect(subject.tool(toolName, input, extra)).toEqual([]);
    expect(subject.manager.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
  }
  // The same harness delivers once the call is ordinary.
  expect(harness().tool("edit", { path: "@pkg/a.ts" })).toHaveLength(1);
});

test("candidate symlinks outside cwd or into dependencies are rejected BEFORE content reads", () => {
  const outside = join(root, "outside.md");
  const dependency = join(cwd, "node_modules", "dep", "instructions.md");
  mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
  writeFileSync(outside, "PRIVATE_OUTSIDE_MARKER");
  writeFileSync(dependency, "DEPENDENCY_MARKER");
  symlinkSync(outside, join(cwd, "pkg", "AGENTS.override.md"));
  symlinkSync(dependency, join(cwd, "pkg", "CODEX.md"));
  write("pkg/AGENTS.md", "safe fallback guidance");
  const subject = harness({
    config: { providers: { openai: ["CODEX.md", "../../outside.md", "../node_modules/dep/instructions.md"] } },
  });
  const reads = spyOn(fs, "readFileSync");
  try {
    const blocks = subject.tool("read", { path: "pkg/a.ts" });
    expect(blocks.map((text) => text.split("\n\n")[1])).toEqual(["safe fallback guidance"]);
    const readPaths = reads.mock.calls.map(([file]) => String(file));
    expect(readPaths).toEqual([fs.realpathSync(join(cwd, "pkg", "AGENTS.md"))]);
    for (const rejected of [
      outside,
      dependency,
      join(cwd, "pkg", "AGENTS.override.md"),
      join(cwd, "pkg", "CODEX.md"),
      join(cwd, "pkg", "../../outside.md"),
    ]) {
      expect(readPaths).not.toContain(fs.realpathSync(rejected));
    }
    expect(deliveredFiles(subject.manager.buildContextEntries()).size).toBe(1);
  } finally {
    reads.mockRestore();
  }
});

test("valid in-tree candidate symlinks retain path and content deduplication", () => {
  write("shared-guide.md", "shared internal guidance");
  symlinkSync(join(cwd, "shared-guide.md"), join(cwd, "pkg", "AGENTS.md"));
  symlinkSync(join(cwd, "shared-guide.md"), join(cwd, "pkg", "CODEX.md"));
  write("pkg/lib/AGENTS.md", "shared internal guidance");
  const subject = harness();
  expect(subject.tool("read", { path: "pkg/lib/a.ts" })).toEqual([
    `Context file ${join(cwd, "pkg", "AGENTS.md")} applies to files below ${join(cwd, "pkg")}:\n\nshared internal guidance`,
  ]);
  expect(subject.tool("read", { path: "pkg/lib/a.ts" })).toEqual([]);
  const loaded = harness();
  loaded.subdirectories.observe([{ path: join(cwd, "shared-guide.md"), content: "older host snapshot" }]);
  // The alias is deduplicated by realpath, even when the loaded content differs.
  expect(loaded.tool("read", { path: "pkg/a.ts" })).toEqual([]);
});

test("reading a context file records it without echoing it; partial reads and edits do not", () => {
  write("pkg/AGENTS.md", "pkg agents");
  write("pkg/CODEX.md", "pkg codex");
  const full = harness();
  expect(full.tool("read", { path: "pkg/AGENTS.md" }).map((text) => text.split("\n\n")[1])).toEqual(["pkg codex"]);
  expect(full.tool("read", { path: "pkg/a.ts" })).toEqual([]);
  const partial = harness();
  expect(partial.tool("read", { path: "pkg/AGENTS.md", offset: 2 })).toHaveLength(1);
  expect(partial.tool("read", { path: "pkg/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual(["pkg agents"]);
  const limited = harness();
  expect(limited.tool("read", { path: "pkg/AGENTS.md", limit: 1 })).toHaveLength(1);
  expect(limited.tool("read", { path: "pkg/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual(["pkg agents"]);
  const written = harness();
  expect(written.tool("write", { path: "pkg/AGENTS.md" })).toHaveLength(1);
  expect(written.tool("read", { path: "pkg/a.ts" })).toEqual([]);
  const edited = harness();
  expect(edited.tool("edit", { path: "pkg/AGENTS.md" })).toHaveLength(1);
  expect(edited.tool("read", { path: "pkg/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual(["pkg agents"]);
});

test("only an actually untruncated read counts as full delivery, with validated truncation details", () => {
  write("pkg/AGENTS.md", "pkg agents");
  const incompleteDetails: unknown[] = [
    { truncation: truncateHead("x\n".repeat(2001)) },
    { truncation: truncateHead("x".repeat(60 * 1024)) },
    { truncation: null },
    { truncation: {} },
    { truncation: { truncated: "false" } },
    "invalid details",
  ];
  for (const details of incompleteDetails) {
    const subject = harness();
    expect(subject.tool("read", { path: "pkg/AGENTS.md" }, { details })).toEqual([]);
    expect(deliveredFiles(subject.manager.buildContextEntries()).size).toBe(0);
    expect(subject.tool("read", { path: "pkg/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual(["pkg agents"]);
  }
  for (const details of [undefined, {}, { truncation: truncateHead("pkg agents") }]) {
    const subject = harness();
    expect(subject.tool("read", { path: "pkg/AGENTS.md" }, { details })).toEqual([]);
    expect(deliveredFiles(subject.manager.buildContextEntries()).size).toBe(1);
    expect(subject.tool("read", { path: "pkg/a.ts" })).toEqual([]);
  }
});

test("changed content and a context edit of the carrying result are redelivered", () => {
  write("pkg/AGENTS.md", "first version");
  const { manager, tool } = harness();
  expect(tool("read", { path: "pkg/a.ts" })).toHaveLength(1);
  expect(tool("read", { path: "pkg/a.ts" })).toEqual([]);
  write("pkg/AGENTS.md", "second version");
  expect(tool("read", { path: "pkg/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual(["second version"]);
  const carrier = manager.getLeafId();
  if (!carrier) throw new Error("missing tool result entry");
  manager.appendContextEdit(carrier, {
    content: [{ type: "text", text: "redacted" }],
  });
  expect(tool("read", { path: "pkg/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual(["second version"]);
});

test("external A -> B -> A changes deliver each latest instruction, then repeated A skips", () => {
  const { tool } = harness();
  for (const content of ["instruction A", "instruction B", "instruction A"]) {
    write("pkg/AGENTS.md", content);
    expect(tool("read", { path: "pkg/a.ts" }).map((text) => text.split("\n\n")[1])).toEqual([content]);
  }
  expect(tool("read", { path: "pkg/a.ts" })).toEqual([]);
});

test("malformed or foreign records do not count as deliveries", () => {
  write("pkg/AGENTS.md", "pkg agents");
  const { manager, tool } = harness();
  manager.appendCustomEntry(SUBDIRECTORY_ENTRY, {
    version: 2,
    toolCallId: "x",
    files: [],
  });
  manager.appendCustomEntry(SUBDIRECTORY_ENTRY, {
    version: 1,
    toolCallId: "x",
    files: [{ path: 1 }],
  });
  manager.appendCustomEntry("other-extension", {
    version: 1,
    toolCallId: "x",
    files: [],
  });
  expect(deliveredFiles(manager.buildContextEntries()).size).toBe(0);
  expect(tool("read", { path: "pkg/a.ts" })).toHaveLength(1);
  expect(deliveredFiles(manager.buildContextEntries()).size).toBe(1);
});

test("files are capped individually and per turn, deferring the rest to a later turn in order", () => {
  mkdirSync(join(cwd, "pkg", "lib", "deep"));
  write("pkg/AGENTS.md", `${"a".repeat(MAX_FILE_BYTES)}tail beyond the cap`);
  write("pkg/lib/AGENTS.md", "b".repeat(MAX_TURN_BYTES - MAX_FILE_BYTES - 1000));
  write("pkg/lib/deep/AGENTS.md", "c".repeat(1000));
  const { subdirectories, tool } = harness();
  const first = tool("read", { path: "pkg/lib/deep/a.ts" });
  expect(first).toHaveLength(3);
  expect(first[0]).not.toContain("tail beyond the cap");
  expect(first[0]).toEndWith(
    `[Truncated to ${MAX_FILE_BYTES} of ${MAX_FILE_BYTES + 19} bytes; read ${join(cwd, "pkg", "AGENTS.md")} for the rest.]`,
  );
  expect(first[1]).toContain("b".repeat(100));
  expect(first[2]).toEndWith(`read them directly: ${join(cwd, "pkg", "lib", "deep", "AGENTS.md")}`);
  expect(Buffer.byteLength(first.slice(0, 2).join(""))).toBeLessThanOrEqual(MAX_TURN_BYTES);
  // Same turn: the budget is spent.
  expect(tool("read", { path: "pkg/lib/deep/b.ts" })).toEqual([first[2]]);
  subdirectories.startTurn();
  expect(tool("read", { path: "pkg/lib/deep/b.ts" }).map((text) => text.split("\n\n")[1])).toEqual(["c".repeat(1000)]);
});

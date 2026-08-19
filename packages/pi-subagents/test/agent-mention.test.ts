import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
  createMentionProvider,
  type MentionTarget,
  mentionItems,
  mentionRoster,
} from "../src/ui/agent-mention.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false, cleanupSucceeded: true })),
  cleanupWorktreeAsync: vi.fn(async () => ({
    hasChanges: false,
    cleanupSucceeded: true,
  })),
  pruneWorktreesAsync: vi.fn(async () => {}),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = (sessionFile?: string) =>
  ({ dispose: vi.fn(), sessionFile }) as any;

/** A run that never settles, so the record stays "running" for the roster. */
const runHanging = () =>
  vi.mocked(runAgent).mockImplementation((async (
    _c: any,
    _t: any,
    _p: any,
    options: any,
  ) => {
    options.onSessionCreated?.(mockSession());
    return new Promise(() => {});
  }) as any);

const runResolving = (sessionFile?: string) =>
  vi.mocked(runAgent).mockImplementation((async (
    _c: any,
    _t: any,
    _p: any,
    options: any,
  ) => {
    const session = mockSession(sessionFile);
    options.onSessionCreated?.(session);
    return { responseText: "done", session, aborted: false, steered: false };
  }) as any);

const typeInfo = (name: string, description = `${name} description.`) => ({
  name,
  description,
});

describe("mentionRoster", () => {
  it("lists agent types when nothing has ever run", async () => {
    const manager = new AgentManager();
    const roster = mentionRoster(manager, [
      typeInfo("Explore"),
      typeInfo("Plan"),
    ]);
    expect(roster.map((t) => t.handle)).toEqual(["explore", "plan"]);
    expect(roster.every((t) => t.kind === "type")).toBe(true);
    await manager.dispose();
  });

  it("puts a live record ahead of the type it would otherwise start", async () => {
    const manager = new AgentManager();
    runHanging();
    manager.spawn(mockPi, mockCtx, "Explore", "go", {
      description: "d",
      isBackground: true,
    });
    const roster = mentionRoster(manager, [
      typeInfo("Explore"),
      typeInfo("Plan"),
    ]);
    // `explore` addresses the running agent, so the type row is dropped entirely.
    expect(roster.map((t) => [t.kind, t.handle])).toEqual([
      ["record", "explore"],
      ["type", "plan"],
    ]);
    await manager.dispose();
  });

  it("orders steerable agents before finished ones", async () => {
    const manager = new AgentManager();
    runResolving();
    const finished = manager.spawn(mockPi, mockCtx, "Explore", "go", {
      description: "d",
      isBackground: true,
    });
    await manager.getRecordMutable(finished)?.promise;
    runHanging();
    manager.spawn(mockPi, mockCtx, "Plan", "go", {
      description: "d",
      isBackground: true,
    });

    const roster = mentionRoster(manager, []);
    expect(roster.map((t) => t.handle)).toEqual(["plan", "explore"]);
    await manager.dispose();
  });

  it("omits nested agents — only top-level agents are addressable", async () => {
    const manager = new AgentManager();
    runHanging();
    const parent = manager.spawn(mockPi, mockCtx, "Explore", "go", {
      description: "d",
      isBackground: true,
    });
    manager.spawn(mockPi, mockCtx, "Plan", "go", {
      description: "d",
      isBackground: true,
      parentAgentId: parent,
      depth: 2,
    });
    const roster = mentionRoster(manager, []);
    expect(roster).toHaveLength(1);
    expect(roster[0].handle).toBe("explore");
    await manager.dispose();
  });

  it("lists an evicted conversation between the live agents and the types", async () => {
    const manager = new AgentManager();
    runResolving("/tmp/gone.jsonl");
    const id = manager.spawn(mockPi, mockCtx, "Explore", "go", {
      description: "d",
      isBackground: true,
    });
    await manager.getRecordMutable(id)?.promise;
    manager.clearCompleted();

    const roster = mentionRoster(manager, [
      typeInfo("Explore"),
      typeInfo("Plan"),
    ]);
    expect(roster.map((t) => [t.kind, t.handle])).toEqual([
      ["resumable", "explore"],
      ["type", "plan"],
    ]);
    await manager.dispose();
  });

  it("renders the display label rather than the raw type", async () => {
    const manager = new AgentManager();
    runHanging();
    manager.spawn(mockPi, mockCtx, "Explore", "go", {
      description: "d",
      isBackground: true,
    });
    const roster = mentionRoster(manager, [], () => "Explorer Deluxe");
    expect(roster[0].kind === "record" && roster[0].typeLabel).toBe(
      "Explorer Deluxe",
    );
    await manager.dispose();
  });
});

describe("mentionItems", () => {
  const roster: MentionTarget[] = [
    {
      kind: "type",
      handle: "explore",
      type: "Explore",
      description: "Search the codebase. More prose.",
    },
    {
      kind: "type",
      handle: "plan",
      type: "Plan",
      description: "Design a plan.",
    },
  ];

  it("offers every handle on a bare `@`", () => {
    const suggestions = mentionItems(roster, "@", 1);
    expect(suggestions?.items.map((i) => i.value)).toEqual([
      "@explore",
      "@plan",
    ]);
    expect(suggestions?.prefix).toBe("@");
  });

  it("prefix-matches case-insensitively", () => {
    expect(mentionItems(roster, "@EXP", 4)?.items.map((i) => i.value)).toEqual([
      "@explore",
    ]);
  });

  it("does not fuzzy-match", () => {
    expect(mentionItems(roster, "@xplore", 7)).toBeNull();
  });

  it("returns null when the token names no agent, so files still complete", () => {
    expect(mentionItems(roster, "@src/", 5)).toBeNull();
  });

  it("returns null mid-token, so an email address is never a mention", () => {
    expect(mentionItems(roster, "me@exp", 6)).toBeNull();
  });

  it("names the action the row will actually take", () => {
    expect(mentionItems(roster, "@exp", 4)?.items[0].description).toContain(
      "start agent",
    );
  });

  it("summarizes to the first sentence", () => {
    expect(mentionItems(roster, "@exp", 4)?.items[0].description).toBe(
      "start agent · Search the codebase.",
    );
  });

  it("sanitizes a description before it reaches the terminal", () => {
    const poisoned: MentionTarget[] = [
      {
        kind: "type",
        handle: "evil",
        type: "Evil",
        description: "[31mred[0m and ‮bidi",
      },
    ];
    const description =
      mentionItems(poisoned, "@evil", 5)?.items[0].description ?? "";
    expect(description).not.toContain("");
    expect(description).not.toContain("‮");
  });
});

describe("createMentionProvider", () => {
  const wrapped = (): AutocompleteProvider => ({
    triggerCharacters: ["@", "/"],
    getSuggestions: vi.fn(async () => ({
      items: [{ value: "file.ts", label: "file.ts" }],
      prefix: "@",
    })),
    applyCompletion: vi.fn(() => ({
      lines: ["applied"],
      cursorLine: 0,
      cursorCol: 7,
    })),
    shouldTriggerFileCompletion: vi.fn(() => true),
  });

  const roster = (): MentionTarget[] => [
    {
      kind: "type",
      handle: "explore",
      type: "Explore",
      description: "Search.",
    },
  ];

  it("declares only `@` — pi unions the wrapped provider's characters itself", () => {
    expect(
      createMentionProvider(wrapped(), roster, () => true).triggerCharacters,
    ).toEqual(["@"]);
  });

  it("answers a token that names an agent", async () => {
    const inner = wrapped();
    const provider = createMentionProvider(inner, roster, () => true);
    const suggestions = await provider.getSuggestions(["@exp"], 0, 4, {
      signal: new AbortController().signal,
    });
    expect(suggestions?.items.map((i) => i.value)).toEqual(["@explore"]);
    expect(inner.getSuggestions).not.toHaveBeenCalled();
  });

  it("delegates a token that names no agent, so `@file` still completes", async () => {
    const inner = wrapped();
    const provider = createMentionProvider(inner, roster, () => true);
    const suggestions = await provider.getSuggestions(["@src/"], 0, 5, {
      signal: new AbortController().signal,
    });
    expect(suggestions?.items.map((i) => i.value)).toEqual(["file.ts"]);
    expect(inner.getSuggestions).toHaveBeenCalled();
  });

  it("delegates everything when mentions are disabled", async () => {
    const inner = wrapped();
    const provider = createMentionProvider(inner, roster, () => false);
    const suggestions = await provider.getSuggestions(["@exp"], 0, 4, {
      signal: new AbortController().signal,
    });
    expect(suggestions?.items.map((i) => i.value)).toEqual(["file.ts"]);
    expect(inner.getSuggestions).toHaveBeenCalled();
  });

  it("delegates applyCompletion — pi's `@` branch already inserts value plus a space", () => {
    const inner = wrapped();
    const provider = createMentionProvider(inner, roster, () => true);
    provider.applyCompletion(
      ["@exp"],
      0,
      4,
      { value: "@explore", label: "@explore" },
      "@exp",
    );
    expect(inner.applyCompletion).toHaveBeenCalled();
  });

  it("defaults shouldTriggerFileCompletion to true when the wrapped provider omits it", () => {
    const inner = { ...wrapped(), shouldTriggerFileCompletion: undefined };
    const provider = createMentionProvider(inner, roster, () => true);
    expect(provider.shouldTriggerFileCompletion?.(["@"], 0, 1)).toBe(true);
  });
});

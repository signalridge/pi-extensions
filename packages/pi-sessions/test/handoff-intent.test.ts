import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionCommandContext, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type Terminal, TUI_KEYBINDINGS, TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { HANDOFF_TYPE, type HandoffRecord, readHandoff } from "../src/handoff.js";
import { persistHandoff } from "../src/storage.js";
import { deferred, fixture } from "./support.js";

const savedRecord = (f: Awaited<ReturnType<typeof fixture>>) => {
  const entry = f.runtime.session.sessionManager
    .getBranch()
    .slice()
    .reverse()
    .find((item) => item.type === "custom" && item.customType === HANDOFF_TYPE);
  if (entry?.type !== "custom") throw new Error("Missing handoff");
  const record = readHandoff(entry.data);
  if (!record) throw new Error("Invalid handoff");
  return record;
};

test("RPC intent persists source model identity, but no source draft or invented draft hash", async () => {
  const f = await fixture();
  try {
    f.editorResults.push("reviewed excerpt", "approved summary");
    await f.command("handoff", "continue");
    expect(savedRecord(f).prefill).toEqual({ sourceModel: "fixture/selected" });
    expect(readFileSync(f.runtime.session.sessionFile as string, "utf8")).not.toContain("original unsent draft");
  } finally {
    await f.cleanup();
  }
});

test("TUI intent stores only SHA256 of the explicitly consented unsent source draft", async () => {
  initTheme("dark", false);
  const terminal: Terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  const tui = new TuiMainScreen(terminal);
  const host = Object.assign(Object.create(InteractiveMode.prototype) as object, {
    ui: tui,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    editor: {
      getText: () => "original unsent draft",
      setText() {
        throw new Error("Native custom must not write editor");
      },
    },
  }) as unknown as { showExtensionCustom: ExtensionCommandContext["ui"]["custom"] };
  const f = await fixture({
    mode: "tui",
    ui: { custom: (factory, options) => host.showExtensionCustom(factory, options) },
  });
  let running: Promise<void> | undefined;
  try {
    running = f.command("handoff", "continue");
    let prior = tui.getFocusedComponent();
    for (const keys of [
      ["\r"], // no generation
      ["\x1b[B", "\r"], // manual consent
      ["approved summary", "\r"],
      ["\x1b[B", "\r"], // consent to replacing source draft
      ["\x1b[B", "\r"], // create
    ]) {
      await vi.waitFor(() => {
        expect(tui.getFocusedComponent()).not.toBeNull();
        expect(tui.getFocusedComponent()).not.toBe(prior);
      });
      prior = tui.getFocusedComponent();
      prior?.render(80);
      for (const key of keys) prior?.handleInput?.(key);
    }
    await running;
    expect(f.editorText).toBe("approved summary");
    expect(savedRecord(f).prefill).toEqual({
      sourceModel: "fixture/selected",
      sourceDraftHash: createHash("sha256").update("original unsent draft").digest("hex"),
    });
    expect(readFileSync(f.runtime.session.sessionFile as string, "utf8")).not.toContain("original unsent draft");
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.runtime.dispose();
    await running;
    await f.cleanup();
    tui.stop();
  }
});

test.each([
  "missing-file",
  "missing-entry",
  "entry-id",
  "entry-data",
  "parent-link",
  "persist-failure",
  "reopen-failure",
])("%s refuses destination consent and prefill instead of trusting a memory-only entry", async (failure) => {
  const f = await fixture();
  try {
    const native = f.runtime.newSession.bind(f.runtime);
    vi.spyOn(f.runtime, "newSession").mockImplementation((options) =>
      native({
        ...options,
        setup: async (manager) => {
          if (failure === "persist-failure")
            vi.spyOn(manager, "getSessionFile").mockReturnValue(join(f.root, "missing-directory", "unwritten.jsonl"));
          if (failure === "reopen-failure")
            vi.spyOn(manager, "setSessionFile").mockImplementation(() => {
              throw new Error("Public re-open unavailable after file creation");
            });
          await options?.setup?.(manager);
          if (failure === "persist-failure" || failure === "reopen-failure") return;
          const path = manager.getSessionFile() as string;
          if (failure === "missing-file") {
            unlinkSync(path);
            return;
          }
          const records = readFileSync(path, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line));
          const entry = records.find((item) => item.type === "custom" && item.customType === HANDOFF_TYPE);
          if (failure === "missing-entry") records.splice(records.indexOf(entry), 1);
          else if (failure === "entry-id") entry.id = "different-entry-id";
          else if (failure === "entry-data") entry.data.summary = "not the approved saved data";
          else records[0].parentSession = join(f.root, "different-parent.jsonl");
          writeFileSync(path, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
        },
      }),
    );
    f.editorResults.push("reviewed excerpt", "approved summary");
    await f.command("handoff", "continue");
    expect(f.runtime.session).not.toBe(f.source);
    expect(f.confirmations).not.toContain("Load approved summary into client editor?");
    expect(f.editorText).toBe("original unsent draft");
    expect(f.notices.join("\n")).toContain(
      failure === "persist-failure" || failure === "reopen-failure" ? "durable handoff setup failed" : "prefill failed",
    );
    if (failure === "reopen-failure") {
      // The original intent really reached disk. A failed public re-open must
      // still leave the destination recovery-only, not auto-fill from ghosts.
      expect(readFileSync(f.runtime.session.sessionFile as string, "utf8")).toContain('"prefill"');
      expect(savedRecord(f).prefill).toBeUndefined();
    }
    expect(f.destinationTurns).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("removing durable approval during destination consent cannot overwrite a later client draft", async () => {
  const consent = deferred<boolean>();
  const entered = deferred<void>();
  const f = await fixture({
    ui: {
      confirm: async (title) => {
        if (title === "Load approved summary into client editor?") {
          entered.resolve();
          return consent.promise;
        }
        return true;
      },
    },
  });
  let running: Promise<void> | undefined;
  try {
    f.editorResults.push("reviewed excerpt", "approved summary");
    running = f.command("handoff", "continue");
    await entered.promise;
    unlinkSync(f.runtime.session.sessionFile as string);
    f.editorText = "later client draft";
    consent.resolve(true);
    await running;
    expect(f.editorText).toBe("later client draft");
    expect(f.destinationTurns).toBe(0);
  } finally {
    consent.resolve(false);
    await running;
    await f.cleanup();
  }
});

test.each(["startup", "resume", "reload", "fork"])(
  "%s leaves persisted intent inert until explicit recovery",
  async (reason) => {
    const f = await fixture();
    let opened: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f.editorResults.push("reviewed excerpt", "approved summary");
      await f.command("handoff", "continue");
      const path = f.runtime.session.sessionFile as string;
      f.editorText = "newer client draft";
      f.confirmations.length = 0;
      if (reason === "startup") opened = await fixture({ initialSessionFile: path });
      else if (reason === "resume") await f.runtime.switchSession(path);
      else if (reason === "reload") await f.runtime.session.reload();
      else await f.runtime.fork(f.runtime.session.sessionManager.getLeafId() as string, { position: "at" });
      const current = opened ?? f;
      expect(current.editorText).toBe(opened ? "original unsent draft" : "newer client draft");
      expect(current.confirmations).not.toContain("Load approved summary into client editor?");
      current.editorResults.push("explicitly recovered summary");
      await current.command("handoff", "recover");
      expect(current.editorText).toBe("explicitly recovered summary");
      expect(current.destinationTurns).toBe(0);
    } finally {
      await opened?.cleanup();
      await f.cleanup();
    }
  },
);

test("legacy v1 handoff without prefill intent is recoverable, but a new session never auto-prefills it", async () => {
  const f = await fixture();
  try {
    await f.runtime.newSession({
      parentSession: f.manager.getSessionFile(),
      setup: async (manager) => {
        manager.appendCustomEntry(HANDOFF_TYPE, {
          version: 1,
          goal: "continue",
          summary: "legacy approved summary",
          sourceSessionId: f.manager.getSessionId(),
          parent: { id: f.manager.getSessionId(), cwd: f.cwd, path: f.manager.getSessionFile() },
        } satisfies HandoffRecord);
        persistHandoff(manager);
      },
    });
    expect(f.editorText).toBe("original unsent draft");
    expect(f.confirmations).toEqual([]);
    expect(savedRecord(f).prefill).toBeUndefined();
    await f.command("handoff", "recover");
    expect(f.editorText).toBe("legacy approved summary");
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test.each([
  null,
  [],
  {},
  { sourceModel: 1 },
  { sourceModel: "unsafe\u0000" },
  { sourceModel: "a".repeat(4097) },
  { sourceModel: "fixture/selected", sourceDraftHash: "raw draft" },
  { sourceModel: "fixture/selected", sourceDraftHash: "f".repeat(63) },
  { sourceModel: "fixture/selected", sourceDraftHash: "f".repeat(64), sourceDraft: "must not be stored" },
])("invalid optional intent cannot authorize prefill: %j", (prefill) => {
  expect(
    readHandoff({
      version: 1,
      goal: "continue",
      summary: "approved",
      sourceSessionId: "source",
      parent: { id: "source", cwd: "/workspace" },
      prefill,
    }),
  ).toBeUndefined();
});

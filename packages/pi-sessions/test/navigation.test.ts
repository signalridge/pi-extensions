import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { vetSession } from "../src/storage.js";
import { fixture } from "./support.js";

function candidate(cwd: string, directory: string, name: string) {
  const manager = SessionManager.create(cwd, directory);
  manager.appendSessionInfo(name);
  manager.appendMessage({
    role: "user",
    content: "Recent user text. /handoff must NOT execute from preview.",
    timestamp: 2,
  });
  return manager;
}

test("default list is workspace scoped; stable selected ID/native withSession restores history without turn", async () => {
  const f = await fixture({ ui: { input: async () => "" } });
  try {
    const other = join(f.root, "other");
    await mkdir(other);
    const target = candidate(f.cwd, f.manager.getSessionDir(), "target");
    candidate(other, f.manager.getSessionDir(), "foreign workspace");
    let visible: string[] = [];
    f.ui.select = async (_title, options) => {
      visible = options;
      return options.find((row) => row.includes(target.getSessionId()));
    };
    await f.command("sessions");
    expect(visible.join("\n")).not.toContain("foreign workspace");
    expect(f.runtime.session.sessionId).toBe(target.getSessionId());
    expect(f.runtime.session.sessionManager.buildSessionContext().messages[0]).toMatchObject({ role: "user" });
    expect(f.withSessions).toBe(1);
    expect(f.generationCalls).toBe(0);
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])(
  "all-workspace requires confirmation=%s; actual SDK recreates cwd-bound services",
  async (confirm) => {
    const f = await fixture({ ui: { input: async () => "" } });
    try {
      const other = join(f.root, "foreign");
      await mkdir(other);
      const target = candidate(other, f.manager.getSessionDir(), "other workspace history");
      const infos = await SessionManager.list(other, f.manager.getSessionDir());
      vi.spyOn(SessionManager, "listAll").mockResolvedValue(infos);
      f.ui.select = async (_title, options) => options.find((row) => row.includes(target.getSessionId()));
      f.ui.confirm = async (title) => {
        f.confirmations.push(title);
        return title === "Cross-workspace session" ? confirm : true;
      };
      const processCwd = process.cwd();
      await f.command("sessions", "all");
      expect(f.confirmations).toContain("Cross-workspace session");
      if (confirm) {
        expect(f.runtime.session.sessionId).toBe(target.getSessionId());
        expect(f.runtime.cwd).toBe(other);
        expect(f.runtime.services.cwd).toBe(other);
        expect(f.runtime.session.extensionRunner.createCommandContext().cwd).toBe(other);
        expect(f.runtime.session.sessionManager.getCwd()).toBe(other);
        expect(f.runtime.services).not.toBeUndefined();
        expect(f.notices.join("\n")).toContain("Native workspace rebind completed");
      } else expect(f.runtime.session).toBe(f.source);
      expect(process.cwd()).toBe(processCwd);
      expect(f.destinationTurns).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  },
);

test("all-workspace enumeration includes foreign histories in the current nonglobal custom directory", async () => {
  const f = await fixture({ ui: { input: async () => "" } });
  try {
    const foreign = join(f.root, "foreign-custom-workspace");
    await mkdir(foreign);
    const local = candidate(f.cwd, f.manager.getSessionDir(), "local custom history");
    const remote = candidate(foreign, f.manager.getSessionDir(), "foreign custom history");
    const nativeAll = SessionManager.listAll.bind(SessionManager);
    // Isolate the unrelated global store, but use real native filesystem
    // enumeration for the custom directory under test (never cwd-filter it).
    vi.spyOn(SessionManager, "listAll").mockImplementation(async (directory, _progress, signal) =>
      typeof directory === "string" ? nativeAll(directory, undefined, signal) : [],
    );
    let visible: string[] = [];
    f.ui.select = async (_title, options) => {
      visible = options;
      return undefined;
    };
    await f.command("sessions");
    expect(visible.join("\n")).toContain(local.getSessionId());
    expect(visible.join("\n")).not.toContain(remote.getSessionId());
    await f.command("sessions", "all");
    expect(visible.join("\n")).toContain(local.getSessionId());
    expect(visible.join("\n")).toContain(remote.getSessionId());
    expect(f.runtime.session).toBe(f.source);
    expect(f.destinationTurns).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("candidate changed after preview is re-vetted and never switched", async () => {
  const f = await fixture({ ui: { input: async () => "" } });
  try {
    const target = candidate(f.cwd, f.manager.getSessionDir(), "target");
    f.ui.select = async (_title, options) => options.find((row) => row.includes(target.getSessionId()));
    f.ui.confirm = async (title) => {
      if (title === "Preview and resume session?")
        target.appendMessage({ role: "user", content: "later unreviewed content", timestamp: 3 });
      return true;
    };
    await f.command("sessions");
    expect(f.runtime.session).toBe(f.source);
    expect(f.withSessions).toBe(0);
    expect(f.notices.join("\n")).toContain("changed after preview");
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("native switch veto leaves original context/history", async () => {
  const f = await fixture({
    ui: { input: async () => "" },
    extra: (pi) => pi.on("session_before_switch", () => ({ cancel: true })),
  });
  try {
    const target = candidate(f.cwd, f.manager.getSessionDir(), "target");
    f.ui.select = async (_title, options) => options.find((row) => row.includes(target.getSessionId()));
    await f.command("sessions");
    expect(f.runtime.session).toBe(f.source);
    expect(f.withSessions).toBe(0);
    expect(f.editorText).toBe("original unsent draft");
  } finally {
    await f.cleanup();
  }
});

test("unreadable/malformed native candidates cannot initialize session files or execute previews", async () => {
  const f = await fixture();
  try {
    const invalid = join(f.root, "invalid.jsonl");
    await writeFile(invalid, '{"type":"session","version":3,"id":"expected","cwd":"/absent","timestamp":"invalid"}\n');
    const signal = new AbortController().signal;
    await expect(vetSession(invalid, "expected", signal)).rejects.toThrow();
    await expect(vetSession(join(f.root, "missing.jsonl"), "expected", signal)).rejects.toThrow();
    const target = candidate(f.cwd, f.manager.getSessionDir(), "target");
    await expect(vetSession(target.getSessionFile() as string, "wrong-stable-id", signal)).rejects.toThrow();
    await writeFile(target.getSessionFile() as string, "not a native session\n");
    await expect(vetSession(target.getSessionFile() as string, target.getSessionId(), signal)).rejects.toThrow();
    expect(f.runtime.session).toBe(f.source);
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test.each(["print", "json"] as const)("%s rejects commands before idle/provider/native mutations", async (mode) => {
  const f = await fixture({ mode });
  try {
    const newSession = vi.spyOn(f.runtime, "newSession");
    const switchSession = vi.spyOn(f.runtime, "switchSession");
    const idle = vi.spyOn(f.source, "waitForIdle");
    await expect(f.command("handoff", "goal")).rejects.toThrow("require TUI or dialog-capable RPC");
    await expect(f.command("sessions", "all")).rejects.toThrow("require TUI or dialog-capable RPC");
    expect(newSession).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
    expect(idle).not.toHaveBeenCalled();
    expect(f.generationCalls).toBe(0);
    expect(f.editors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

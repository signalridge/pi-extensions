import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { fixture } from "./support.js";

test("pre-replacement native failure removes only its private parent snapshot", async () => {
  const f = await fixture({ memory: true });
  let parent = "";
  try {
    vi.spyOn(f.runtime, "newSession").mockImplementation(async (options) => {
      parent = options?.parentSession ?? "";
      expect(existsSync(parent)).toBe(true);
      throw new Error("unavailable before replacement: secret raw detail");
    });
    f.editorResults.push("context", "summary");
    await f.command("handoff", "continue");
    expect(parent).toContain("pi-sessions-parent-");
    expect(existsSync(dirname(parent))).toBe(false);
    expect(f.runtime.session).toBe(f.source);
    expect(f.editorText).toBe("original unsent draft");
    expect(f.notices.join("\n")).not.toContain("secret raw detail");
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("committed shutdown retains resumable parent; custom-only destination is durable without first turn", async () => {
  const f = await fixture({ memory: true });
  try {
    f.editorResults.push("context", "summary");
    await f.command("handoff", "continue");
    const header = f.runtime.session.sessionManager.getHeader();
    const destination = f.runtime.session.sessionFile as string;
    const parent = header?.parentSession as string;
    await f.runtime.dispose();
    expect(existsSync(parent)).toBe(true);
    expect(SessionManager.open(parent).getBranch()).toEqual(f.manager.getBranch());
    expect(existsSync(destination)).toBe(true);
    expect(SessionManager.open(destination).buildSessionContext().messages).toEqual([]);
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("public destination persistence stays coherent when human later appends a message", async () => {
  const f = await fixture();
  try {
    f.editorResults.push("context", "summary");
    await f.command("handoff", "continue");
    const destination = f.runtime.session.sessionManager;
    destination.appendMessage({ role: "user", content: "Human explicitly submitted later", timestamp: 100 });
    const reopened = SessionManager.open(destination.getSessionFile() as string);
    expect(reopened.buildSessionContext().messages).toEqual([
      { role: "user", content: "Human explicitly submitted later", timestamp: 100 },
    ]);
    expect(
      reopened.getEntries().some((entry) => entry.type === "custom" && entry.customType === "pi-sessions:handoff"),
    ).toBe(true);
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("missing model in fresh withSession context only prefills, warns and never submits", async () => {
  const f = await fixture();
  try {
    const native = f.runtime.newSession.bind(f.runtime);
    vi.spyOn(f.runtime, "newSession").mockImplementation((options) =>
      native({
        ...options,
        withSession: async (ctx) => options?.withSession?.({ ...ctx, model: undefined }),
      }),
    );
    f.editorResults.push("context", "summary");
    await f.command("handoff", "continue");
    expect(f.notices.join("\n")).toContain("Destination model changed or is missing");
    expect(f.editorText).toBe("summary");
    expect(f.destinationTurns).toBe(0);
    expect(f.withSessions).toBe(1);
  } finally {
    await f.cleanup();
  }
});

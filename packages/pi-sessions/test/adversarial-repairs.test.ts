import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AssistantMessageComponent, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { HANDOFF_TYPE, readHandoff } from "../src/handoff.js";
import { Owner } from "../src/ownership.js";
import { validateEntryPayload } from "../src/session-payload.js";
import { vetSession } from "../src/storage.js";
import { deferred, fixture, response } from "./support.js";

initTheme("dark", false);

for (const stopReason of ["aborted", "error"] as const) {
  test(`${stopReason} malformed assistant errorMessage crashes native renderer, never reaches native navigation`, async () => {
    // JSON data, not a live malicious prototype or mocked renderer.
    const message: unknown = JSON.parse(
      JSON.stringify({ ...response("partial", stopReason), errorMessage: { toString: 0 } }),
    );
    expect(() => new AssistantMessageComponent(message as never).render(80)).toThrow();
    const f = await fixture({ ui: { input: async () => "" } });
    try {
      const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
      const parentId = target.appendMessage({ role: "user", content: "valid target", timestamp: 1 });
      const path = target.getSessionFile() as string;
      await appendFile(
        path,
        `${JSON.stringify({ type: "message", id: "bad-assistant", parentId, timestamp: new Date().toISOString(), message })}\n`,
      );
      const before = readFileSync(path, "utf8");
      f.ui.select = async (_title, options) => options.find((option) => option.includes(target.getSessionId()));
      const switchSession = vi.spyOn(f.runtime, "switchSession");
      await f.command("sessions");
      expect(switchSession).not.toHaveBeenCalled();
      expect(f.runtime.session).toBe(f.source);
      expect(f.source.extensionRunner.createCommandContext().isIdle()).toBe(true);
      // Prove the source still accepts normal native operations, not just its identity.
      f.manager.appendMessage({ role: "user", content: "still usable", timestamp: 2 });
      expect(f.manager.buildSessionContext().messages.at(-1)).toMatchObject({ content: "still usable" });
      expect(readFileSync(path, "utf8")).toBe(before);
      await expect(vetSession(path, target.getSessionId(), new AbortController().signal)).rejects.toThrow();
      expect(f.destinationTurns).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });

  test.each([undefined, "", "Request was aborted", "provider unavailable"])(
    `${stopReason} permits optional string errorMessage=%j`,
    (errorMessage) => {
      const message = { ...response("partial", stopReason), ...(errorMessage === undefined ? {} : { errorMessage }) };
      expect(() => validateEntryPayload({ type: "message", message }, new Map())).not.toThrow();
      expect(() => new AssistantMessageComponent(message).render(80)).not.toThrow();
    },
  );
}

const recordFrom = (manager: SessionManager) => {
  const entry = manager
    .getBranch()
    .reverse()
    .find((item) => item.type === "custom" && item.customType === HANDOFF_TYPE);
  const record = entry?.type === "custom" ? readHandoff(entry.data) : undefined;
  if (!record) throw new Error("Missing handoff");
  return record;
};

for (const veto of [false, true]) {
  test(`consecutive in-memory handoffs preserve ordinary human context and native ancestry; veto=${veto}`, async () => {
    const f = await fixture({
      memory: true,
      extra: (pi) =>
        pi.on("session_before_switch", (_event, ctx) =>
          veto && ctx.sessionManager !== f.manager ? { cancel: true } : undefined,
        ),
    });
    let snapshot = "";
    try {
      f.editorResults.push("first excerpt", "first approved summary");
      await f.command("handoff", "first");
      const source = f.runtime.session;
      const manager = source.sessionManager;
      const path = manager.getSessionFile() as string;
      const originalBytes = readFileSync(path, "utf8");
      const originalParent = manager.getHeader()?.parentSession;
      expect(originalParent).toBe(recordFrom(manager).parent.path);
      expect(manager.isPersisted()).toBe(false); // --no-session remains in-memory.
      // Explicit ordinary faux human turn/response, not an automatic handoff turn.
      manager.appendMessage({ role: "user", content: "Human explicitly asks the next question", timestamp: 100 });
      manager.appendMessage(response("Ordinary faux response between handoffs"));
      const branch = structuredClone(manager.getBranch());
      const context = manager.buildSessionContext().messages;
      expect(readFileSync(path, "utf8")).toBe(originalBytes); // The native manager intentionally does not persist.
      const native = f.runtime.newSession.bind(f.runtime);
      vi.spyOn(f.runtime, "newSession").mockImplementation(async (options) => {
        snapshot = options?.parentSession ?? "";
        f.track(snapshot);
        expect(snapshot).not.toBe(path);
        expect(SessionManager.open(snapshot).getBranch()).toEqual(branch);
        expect(source.extensionRunner.createCommandContext().isIdle()).toBe(true);
        return native(options);
      });
      f.editorResults.push("second excerpt", "second approved summary");
      await f.command("handoff", "second");
      expect(snapshot).toContain("pi-sessions-parent-");
      expect(readFileSync(path, "utf8")).toBe(originalBytes);
      expect(f.destinationTurns).toBe(0);
      expect(f.runtime.session.extensionRunner.createCommandContext().isIdle()).toBe(true);
      if (veto) {
        expect(f.runtime.session).toBe(source);
        expect(existsSync(dirname(snapshot))).toBe(false);
        manager.appendCustomEntry("still usable after veto");
        expect(manager.getLeafEntry()).toMatchObject({ customType: "still usable after veto" });
      } else {
        const destination = f.runtime.session.sessionManager;
        const record = recordFrom(destination);
        expect(record.parent.path).toBe(snapshot);
        expect(record.parent.id).toBe(SessionManager.open(snapshot).getSessionId());
        expect(record.parent.id).not.toBe(manager.getSessionId());
        expect(record.sourceSessionId).toBe(manager.getSessionId());
        expect(destination.getHeader()?.parentSession).toBe(snapshot);
        expect(SessionManager.open(destination.getSessionFile() as string).getHeader()?.parentSession).toBe(snapshot);
        expect(SessionManager.open(snapshot).buildSessionContext().messages).toEqual(context);
        expect(SessionManager.open(snapshot).getHeader()?.parentSession).toBe(originalParent);
      }
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
}

test("a same-ID same-leaf saved record with different payload is stale, not a reusable parent", async () => {
  const f = await fixture();
  try {
    const path = f.manager.getSessionFile() as string;
    const entries = structuredClone(f.manager.getEntries());
    const last = entries
      .slice()
      .reverse()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (last?.type !== "message" || last.message.role !== "assistant") throw new Error("Missing assistant");
    last.message.content = [{ type: "text", text: "stale payload under same ID" }];
    const staleBytes = `${[f.manager.getHeader(), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    writeFileSync(path, staleBytes);
    const branch = structuredClone(f.manager.getBranch());
    f.editorResults.push("context", "summary");
    await f.command("handoff", "continue");
    const record = recordFrom(f.runtime.session.sessionManager);
    expect(record.parent.path).not.toBe(path);
    expect(SessionManager.open(record.parent.path as string).getBranch()).toEqual(branch);
    expect(readFileSync(path, "utf8")).toBe(staleBytes);
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("malformed existing source storage is rejected rather than silently replaced with a snapshot", async () => {
  const f = await fixture({ memory: true });
  try {
    f.editorResults.push("context", "summary");
    await f.command("handoff", "first");
    const source = f.runtime.session;
    const path = source.sessionFile as string;
    const malformed = `${readFileSync(path, "utf8")}not JSON\n`;
    writeFileSync(path, malformed);
    source.sessionManager.appendMessage({ role: "user", content: "new memory context", timestamp: 2 });
    const newSession = vi.spyOn(f.runtime, "newSession");
    f.editorResults.push("context", "summary");
    await f.command("handoff", "second");
    expect(newSession).not.toHaveBeenCalled();
    expect(f.runtime.session).toBe(source);
    expect(readFileSync(path, "utf8")).toBe(malformed);
    expect(f.destinationTurns).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test("second delivered new_session attempt revokes first held handoff approval even when later vetoed", async () => {
  const entered = deferred<void>();
  const permit = deferred<void>();
  let attempts = 0;
  const f = await fixture({
    extra: (pi) =>
      pi.on("session_before_switch", async (_event, ctx) => {
        if (ctx.sessionManager !== f.manager) return;
        if (++attempts === 1) {
          entered.resolve();
          await permit.promise;
        } else return { cancel: true };
      }),
  });
  let running: Promise<void> | undefined;
  try {
    f.editorResults.push("context", "approved recovery summary");
    running = f.command("handoff", "continue");
    await entered.promise;
    expect((await f.runtime.newSession()).cancelled).toBe(true); // The RPC new_session action uses this public runtime API.
    expect(attempts).toBe(2); // Independent human attempt was delivered, not blocked as stale own commit.
    expect(f.runtime.session).toBe(f.source);
    permit.resolve();
    await running;
    expect(f.runtime.session).not.toBe(f.source);
    const record = recordFrom(f.runtime.session.sessionManager);
    expect(record.summary).toBe("approved recovery summary");
    expect(record.prefill).toBeUndefined();
    expect(recordFrom(SessionManager.open(f.runtime.session.sessionFile as string)).prefill).toBeUndefined();
    expect(f.confirmations).not.toContain("Load approved summary into client editor?");
    expect(f.editorText).toBe("original unsent draft");
    expect(f.destinationTurns).toBe(0);
  } finally {
    permit.resolve();
    await running;
    await f.cleanup();
  }
});

test("matching resume exemption is single-use while independent second attempt still reaches later veto", async () => {
  const entered = deferred<void>();
  const permit = deferred<void>();
  let attempts = 0;
  const f = await fixture({
    ui: { input: async () => "" },
    extra: (pi) =>
      pi.on("session_before_switch", async () => {
        if (++attempts === 1) {
          entered.resolve();
          await permit.promise;
        } else return { cancel: true };
      }),
  });
  let running: Promise<void> | undefined;
  const shutdown = vi.spyOn(Owner.prototype, "shutdown");
  try {
    const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
    target.appendMessage({ role: "user", content: "resume target", timestamp: 1 });
    const path = target.getSessionFile() as string;
    f.ui.select = async (_title, options) => options.find((option) => option.includes(target.getSessionId()));
    running = f.command("sessions");
    await entered.promise;
    // Observe only our own Owner class; no private host attempt observer.
    expect((await f.runtime.switchSession(path)).cancelled).toBe(true);
    expect(attempts).toBe(2);
    permit.resolve();
    await running;
    const sourceOwner = shutdown.mock.instances.find(
      (candidate): candidate is Owner => candidate instanceof Owner && candidate.committing === "resume",
    );
    expect(sourceOwner).toBeDefined();
    expect(sourceOwner?.replacementApproved).toBe(false);
    expect(f.runtime.session.sessionId).toBe(target.getSessionId());
    expect(f.destinationTurns).toBe(0);
  } finally {
    permit.resolve();
    await running;
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test.each(["ancestor", "sibling"] as const)(
  "handoff snapshots the selected %s branch rather than the parent file's default leaf",
  async (selection) => {
    const f = await fixture();
    try {
      const path = f.manager.getSessionFile() as string;
      const earlier = f.manager.getLeafId() as string;
      f.manager.appendMessage({ role: "user", content: "Abandoned continuation", timestamp: 100 });
      const later = f.manager.appendMessage(response("Later main continuation"));
      if (selection === "sibling") {
        expect((await f.source.navigateTree(earlier, { summarize: false })).cancelled).toBe(false);
        f.manager.appendMessage({ role: "user", content: "Different sibling branch", timestamp: 101 });
        f.manager.appendMessage(response("Sibling response"));
      }
      const selected = selection === "ancestor" ? earlier : later;
      expect((await f.source.navigateTree(selected, { summarize: false })).cancelled).toBe(false);
      const branch = structuredClone(f.manager.getBranch());
      const context = f.manager.buildSessionContext().messages;
      const savedBytes = readFileSync(path, "utf8");
      expect(f.manager.getLeafId()).toBe(selected);
      expect(SessionManager.open(path).getLeafId()).not.toBe(selected);
      f.editorResults.push("reviewed source", "Selected branch summary");
      await f.command("handoff", "continue selected branch");
      const record = recordFrom(f.runtime.session.sessionManager);
      if (record.parent.path !== path && record.parent.path) f.track(record.parent.path);
      expect(record.parent.path).not.toBe(path);
      const parent = SessionManager.open(record.parent.path as string);
      expect(parent.getLeafId()).toBe(selected);
      expect(parent.getBranch()).toEqual(branch);
      expect(parent.buildSessionContext().messages).toEqual(context);
      expect(parent.getHeader()?.parentSession).toBe(f.manager.getHeader()?.parentSession);
      expect(readFileSync(path, "utf8")).toBe(savedBytes);
      expect(f.destinationTurns).toBe(0);
    } finally {
      await f.cleanup();
    }
  },
);

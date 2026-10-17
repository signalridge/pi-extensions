import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { buildSessionProjection, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { validateEntryPayload } from "../src/session-payload.js";
import { vetSession } from "../src/storage.js";
import { rowsFrom } from "../src/ui.js";
import { fixture } from "./support.js";

const system = { role: "system", content: "safe", timestamp: 1 };
const invalidSystemFields = [
  { toolsAdded: {} },
  { toolsAdded: [null] },
  { toolsAdded: [{ name: "read", description: {}, parameters: {} }] },
  { toolsAdded: [{ name: "read", description: "read", parameters: null }] },
  { toolsRemoved: {} },
  { toolsRemoved: [null] },
  { toolsRemoved: [{ name: 1 }] },
  { sections: [] },
  { sections: { cwd: {} } },
];
for (const checkpoint of [false, true]) {
  test.each(invalidSystemFields)(`rejects malformed system delta checkpoint=${checkpoint}: %j`, async (fields) => {
    const f = await fixture();
    try {
      const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
      const parentId = target.appendMessage({ role: "user", content: "valid", timestamp: 1 });
      const payload = checkpoint
        ? {
            type: "compaction",
            summary: "summary",
            firstKeptEntryId: parentId,
            tokensBefore: 1,
            systemMessage: { ...system, ...fields },
          }
        : { type: "message", message: { ...system, ...fields } };
      const path = target.getSessionFile() as string;
      await appendFile(
        path,
        `${JSON.stringify({ id: "bad", parentId, timestamp: new Date().toISOString(), ...payload })}\n`,
      );
      const before = await readFile(path, "utf8");
      await expect(vetSession(path, target.getSessionId(), new AbortController().signal)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await f.cleanup();
    }
  });
}

test("public system replay demonstrates the unsafe shape and accepts legitimate sections and tools", () => {
  expect(() => getCurrentSystemMessage([{ ...system, toolsAdded: {} } as never])).toThrow();
  const message = {
    ...system,
    sections: { cwd: "/workspace", removed: null },
    toolsAdded: [{ name: "read", description: "read files", parameters: {} }],
    toolsRemoved: [{ name: "old" }],
  };
  expect(() => validateEntryPayload({ type: "message", message }, new Map())).not.toThrow();
  const projected = buildSessionProjection([
    { type: "message", id: "s", parentId: null, timestamp: new Date().toISOString(), message } as never,
  ]);
  const replayed = getCurrentSystemMessage(projected.messages);
  expect(replayed?.toolsAdded?.[0].name).toBe("read");
  expect(replayed && estimateTokens(replayed)).toBeGreaterThan(0);
});

test.each([false, true])(
  "malformed system checkpoint=%s is rejected before native switch/rebinding",
  async (checkpoint) => {
    const f = await fixture({ ui: { input: async () => "" } });
    try {
      const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
      const parentId = target.appendMessage({ role: "user", content: "valid target", timestamp: 1 });
      const badSystem = { ...system, toolsAdded: {} };
      const payload = checkpoint
        ? {
            type: "compaction",
            summary: "summary",
            firstKeptEntryId: parentId,
            tokensBefore: 1,
            systemMessage: badSystem,
          }
        : { type: "message", message: badSystem };
      const path = target.getSessionFile() as string;
      await appendFile(
        path,
        `${JSON.stringify({ ...payload, id: "bad-system", parentId, timestamp: new Date().toISOString() })}\n`,
      );
      const before = await readFile(path, "utf8");
      f.ui.select = async (_title, options) => options.find((option) => option.includes(target.getSessionId()));
      const switchSession = vi.spyOn(f.runtime, "switchSession");
      await f.command("sessions");
      expect(switchSession).not.toHaveBeenCalled();
      expect(f.runtime.session).toBe(f.source);
      expect(f.source.extensionRunner.createCommandContext().isIdle()).toBe(true);
      expect(await readFile(path, "utf8")).toBe(before);
      expect(f.destinationTurns).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  },
);

test("actual v2 hookMessage migrates in memory only; digest remains original bytes", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "historical.jsonl");
    const body = `${[
      { type: "session", version: 2, id: "historical", cwd: f.cwd, timestamp: new Date().toISOString() },
      {
        type: "message",
        id: "hook",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "hookMessage",
          customType: "historical-extension",
          content: "native historical context",
          display: true,
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    await writeFile(path, body);
    const candidate = await vetSession(path, "historical", new AbortController().signal);
    expect(candidate.entries[0]).toMatchObject({ message: { role: "custom", customType: "historical-extension" } });
    expect(candidate.digest).toBe(createHash("sha256").update(body).digest("hex"));
    expect(await readFile(path, "utf8")).toBe(body);
  } finally {
    await f.cleanup();
  }
});

test.each(["", "all"])(
  "mixed directory discovery %j skips missing ID/invalid date without losing valid sessions",
  async (scope) => {
    const f = await fixture({ ui: { input: async () => "" } });
    try {
      const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
      target.appendMessage({ role: "user", content: "valid target", timestamp: 1 });
      const header = { type: "session", version: 3, cwd: f.cwd, timestamp: new Date().toISOString() };
      await writeFile(join(f.manager.getSessionDir(), "missing-id.jsonl"), `${JSON.stringify(header)}\n`);
      await writeFile(
        join(f.manager.getSessionDir(), "invalid-date.jsonl"),
        `${JSON.stringify({ ...header, id: "bad-date", timestamp: "invalid" })}\n`,
      );
      const nativeAll = SessionManager.listAll.bind(SessionManager);
      vi.spyOn(SessionManager, "listAll").mockImplementation(async (directory, _progress, signal) =>
        typeof directory === "string" ? nativeAll(directory, undefined, signal) : [],
      );
      let visible: string[] = [];
      f.ui.select = async (_title, options) => {
        visible = options;
        return undefined;
      };
      await f.command("sessions", scope);
      expect(visible.join("\n")).toContain(target.getSessionId());
      expect(visible.join("\n")).not.toContain("bad-date");
      const infos = await SessionManager.list(f.cwd, f.manager.getSessionDir());
      const good = infos.find((info) => info.id === target.getSessionId());
      expect(good).toBeDefined();
      expect(
        rowsFrom([null, {}, { ...good, modified: new Date("invalid") }, { ...good, name: {} }, good] as never).map(
          (row) => row.id,
        ),
      ).toEqual([target.getSessionId()]);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  },
);

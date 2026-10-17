import { appendFile, readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { vetSession } from "../src/storage.js";
import { fixture, response } from "./support.js";

test("malformed context edit is rejected before native replacement and source remains usable", async () => {
  const f = await fixture({ ui: { input: async () => "" } });
  try {
    const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
    const user = target.appendMessage({ role: "user", content: "candidate", timestamp: 1 });
    const path = target.getSessionFile() as string;
    await appendFile(
      path,
      `${JSON.stringify({ type: "context_edit", id: "bad", parentId: user, targetId: user, timestamp: new Date().toISOString() })}\n`,
    );
    const original = await readFile(path, "utf8");
    expect(
      (await SessionManager.list(f.cwd, f.manager.getSessionDir())).some((info) => info.id === target.getSessionId()),
    ).toBe(true);
    f.ui.select = async (_title, options) => options.find((option) => option.includes(target.getSessionId()));
    const switchSession = vi.spyOn(f.runtime, "switchSession");
    await f.command("sessions");
    expect(switchSession).not.toHaveBeenCalled();
    expect(f.runtime.session).toBe(f.source);
    expect(f.source.extensionRunner.createCommandContext().isIdle()).toBe(true);
    await f.command("sessions", "invalid");
    expect(f.notices.join("\n")).toContain("Usage: /sessions");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(f.destinationTurns).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

test.each([
  { type: "context_edit", replacement: undefined },
  { type: "context_edit", replacement: {} },
  { type: "context_edit", replacement: { content: 42 } },
  { type: "context_edit", targetId: "missing", replacement: null },
  { type: "context_edit", targetId: "state-only", replacement: null },
  { type: "compaction", summary: {}, firstKeptEntryId: "user", tokensBefore: 1 },
  { type: "compaction", summary: "summary", firstKeptEntryId: "user", tokensBefore: null },
  { type: "compaction", summary: "summary", firstKeptEntryId: "user", tokensBefore: 1, systemMessage: {} },
  { type: "branch_summary", summary: {}, fromId: "user" },
  { type: "model_change", provider: {}, modelId: "model" },
  { type: "thinking_level_change", thinkingLevel: null },
  { type: "usage", kind: "test", provider: "test", model: "test", usage: null },
  { type: "custom", customType: {} },
  { type: "custom_message", customType: "test", content: [], display: "yes" },
  { type: "custom_message", customType: "test", content: [null], display: false },
  { type: "label", targetId: "user", label: {} },
  { type: "session_info", name: {} },
])("rejects malformed native payload $type without modifying the file", async (payload) => {
  const f = await fixture();
  try {
    const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
    const user = target.appendMessage({ role: "user", content: "valid user", timestamp: 1 });
    const stateOnly = target.appendCustomEntry("state-only");
    const path = target.getSessionFile() as string;
    const data: Record<string, unknown> = payload;
    const entry = {
      id: "invalid-payload",
      parentId: stateOnly,
      timestamp: new Date().toISOString(),
      ...payload,
      targetId: data.targetId === "state-only" ? stateOnly : data.targetId === "missing" ? "missing" : user,
    };
    await appendFile(path, `${JSON.stringify(entry)}\n`);
    const before = await readFile(path, "utf8");
    await expect(vetSession(path, target.getSessionId(), new AbortController().signal)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await f.cleanup();
  }
});

test.each([2, 3])(
  "preflights valid native v%s edits, omissions, custom content and compaction without IO mutation",
  async (version) => {
    const f = await fixture();
    try {
      const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
      const user = target.appendMessage({ role: "user", content: "before", timestamp: 1 });
      target.appendThinkingLevelChange("off");
      target.appendModelChange("fixture", "model");
      const assistant = target.appendMessage(response("before assistant"));
      target.appendContextEdit(user, { content: "after user" });
      target.appendContextEdit(assistant, null);
      const custom = target.appendCustomMessageEntry("test", [{ type: "text", text: "custom" }], false);
      target.appendContextEdit(custom, { content: "after custom" });
      target.appendLabelChange(user, "label");
      target.appendLabelChange(user, undefined);
      target.appendCompaction("summary", null, 10);
      target.appendMessage({ role: "user", content: "after compaction", timestamp: 2 });
      const path = target.getSessionFile() as string;
      const records = (await readFile(path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      records[0].version = version;
      await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      const before = await readFile(path, "utf8");
      const candidate = await vetSession(path, target.getSessionId(), new AbortController().signal);
      expect(candidate.header.version).toBe(version);
      expect(candidate.preview).toContain("after compaction");
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await f.cleanup();
    }
  },
);

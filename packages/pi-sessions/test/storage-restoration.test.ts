import * as fs from "node:fs/promises";
import { AssistantMessageComponent, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { vetSession } from "../src/storage.js";
import { fixture, response } from "./support.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
initTheme("dark", false);
beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(actual.open);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset();
});
const usage = response("valid").usage;

test.each([
  { type: "usage", kind: "cache_warm", provider: "fixture", model: "model", usage: {} },
  { type: "usage", kind: "cache_warm", provider: "fixture", model: "model", usage: { ...usage, cost: {} } },
  {
    type: "usage",
    kind: "cache_warm",
    provider: "fixture",
    model: "model",
    usage: { ...usage, cost: { ...usage.cost, total: "1" } },
  },
  { type: "compaction", summary: "valid", firstKeptEntryId: "bad-payload", tokensBefore: 1, usage: {} },
  { type: "branch_summary", summary: "valid", fromId: "previous", usage: { ...usage, cost: null } },
  { type: "message", message: { ...response("valid"), content: "hello" } },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "test",
      content: "string",
      timestamp: 1,
      isError: false,
    },
  },
  { type: "message", message: { ...response("valid"), usage: {} } },
])("rejects payload $type that native restoration consumes beyond pure projection", async (payload) => {
  const f = await fixture();
  try {
    const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
    const parentId = target.appendMessage({ role: "user", content: "valid", timestamp: 1 });
    const path = target.getSessionFile() as string;
    await fs.appendFile(
      path,
      `${JSON.stringify({ id: "bad-payload", parentId, timestamp: new Date().toISOString(), ...payload })}\n`,
    );
    await expect(vetSession(path, target.getSessionId(), new AbortController().signal)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("string assistant content fails the real native component; preflight rejects before native switch/rebinding", async () => {
  const f = await fixture({ ui: { input: async () => "" } });
  try {
    const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
    const parentId = target.appendMessage({ role: "user", content: "valid", timestamp: 1 });
    const message = { ...response("valid"), content: "hello" };
    // Deliberately malformed persisted data; demonstrate the actual host consumer,
    // not just a mocked throw or a successful context projection.
    expect(() => new AssistantMessageComponent(message as never)).toThrow();
    const path = target.getSessionFile() as string;
    await fs.appendFile(
      path,
      `${JSON.stringify({ id: "bad-assistant", parentId, timestamp: new Date().toISOString(), type: "message", message })}\n`,
    );
    f.ui.select = async (_title, options) => options.find((option) => option.includes(target.getSessionId()));
    const switchSession = vi.spyOn(f.runtime, "switchSession");
    await f.command("sessions");
    expect(switchSession).not.toHaveBeenCalled();
    expect(f.source.extensionRunner.createCommandContext().isIdle()).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("valid native usage and text-array system checkpoints are accepted", async () => {
  const f = await fixture();
  try {
    const target = SessionManager.create(f.cwd, f.manager.getSessionDir());
    target.appendMessage({ role: "system", content: [{ type: "text", text: "system instructions" }], timestamp: 1 });
    const user = target.appendMessage({ role: "user", content: "valid user", timestamp: 1 });
    target.appendMessage(response("valid assistant"));
    target.appendUsage("cache_warm", "fixture", "model", usage);
    target.appendCompaction("valid summary", user, 10, undefined, false, usage);
    const path = target.getSessionFile() as string;
    await expect(vetSession(path, target.getSessionId(), new AbortController().signal)).resolves.toMatchObject({
      path,
    });
  } finally {
    await f.cleanup();
  }
});

test("file growth after initial stat never causes a read beyond FILE_BYTES plus one probe byte", async () => {
  const f = await fixture();
  const limit = 32 * 1024 * 1024;
  try {
    const path = f.manager.getSessionFile() as string;
    const { open: originalOpen } = await vi.importActual<typeof fs>("node:fs/promises");
    let readBytes = 0;
    let readFileCalls = 0;
    let grew = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== path) return handle;
      const nativeStat = handle.stat.bind(handle);
      const nativeRead = handle.read.bind(handle);
      const nativeReadFile = handle.readFile.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
        const result = await nativeStat(...statArgs);
        if (!grew) {
          grew = true;
          // Real external growth, deterministically after the successful first stat.
          await fs.appendFile(path, " ".repeat(limit + 1024 * 1024));
        }
        return result;
      });
      handle.read = vi.fn(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await nativeRead(...readArgs);
        readBytes += result.bytesRead;
        return result;
      }) as typeof handle.read;
      handle.readFile = vi.fn(async (...readArgs: Parameters<typeof handle.readFile>) => {
        readFileCalls++;
        const result = await nativeReadFile(...readArgs);
        readBytes += Buffer.byteLength(result);
        return result;
      }) as typeof handle.readFile;
      return handle;
    });
    await expect(vetSession(path, f.manager.getSessionId(), new AbortController().signal)).rejects.toThrow();
    expect(grew).toBe(true);
    expect(readFileCalls, `Unbounded readFile consumed ${readBytes} bytes`).toBe(0);
    expect(readBytes).toBeLessThanOrEqual(limit + 1);
  } finally {
    await f.cleanup();
  }
});

import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";

function hostFixture(exec?: ExtensionAPI["exec"], snippet = "const a = 1;") {
  const handlers = new Map<string, () => void>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const pending = new Map<number, (value: boolean | string | undefined) => void>();
  const retainedReplies = new Map<number, (value: boolean | string | undefined) => void>();
  const execs: string[] = [];
  const signals: AbortSignal[] = [];
  let requestId = 0;
  let draft = "client draft";
  let writes = 0;
  let retiredReads = 0;
  const notices: string[] = [];
  const agentSignal = new AbortController().signal;
  extension({
    on: (name: string, handler: () => void) => {
      handlers.set(name, handler);
      return () => {};
    },
    exec:
      exec ??
      (async (name: string) => {
        execs.push(name);
        return { code: 0, stdout: "", stderr: "" };
      }),
    registerCommand: (_name: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    },
  } as never);

  function dialog<T extends boolean | string | undefined>(fallback: T, options?: ExtensionUIDialogOptions) {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.resolve(fallback);
    if (signal) signals.push(signal);
    const id = ++requestId;
    return new Promise<T>((resolve) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
      };
      const onAbort = () => {
        cleanup();
        resolve(fallback);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const reply = (value: boolean | string | undefined) => {
        cleanup();
        resolve(value as T);
      };
      pending.set(id, reply);
      retainedReplies.set(id, reply);
    });
  }

  function context(sessionId = "session", leafId = "a") {
    let retired = false;
    const ctx = new Proxy(
      {
        mode: "rpc",
        hasUI: true,
        cwd: process.cwd(),
        signal: agentSignal,
        sessionManager: {
          getSessionId: () => sessionId,
          getLeafId: () => leafId,
          getBranch: () => [
            {
              type: "message",
              id: leafId,
              timestamp: "",
              message: { role: "assistant", content: `\`\`\`sh\n${snippet}\n\`\`\`` },
            },
          ],
        },
        ui: {
          // Pi RPC dialogs (unchanged from 1.0.4 to 1.4.0) stay pending until a reply or the supplied signal aborts.
          confirm: (_title: string, _message: string, options?: ExtensionUIDialogOptions) => dialog(false, options),
          select: (_title: string, _items: string[], options?: ExtensionUIDialogOptions) => dialog(undefined, options),
          getEditorText: () => {
            throw new Error("RPC cannot read client drafts");
          },
          setEditorText: (text: string) => {
            writes += 1;
            draft = text;
          },
          notify: (message: string) => notices.push(message),
        },
      },
      {
        get(target, property, receiver) {
          if (retired) {
            retiredReads += 1;
            throw new Error("Retired host context accessed");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as unknown as ExtensionCommandContext;
    return { ctx, retire: () => (retired = true) };
  }

  return {
    command,
    context,
    pending,
    signals,
    agentSignal,
    notices,
    execs,
    emit: (name: string) => {
      const handler = handlers.get(name);
      assert.ok(handler, `${name} handler registered`);
      handler();
    },
    reply: (id: number, value: boolean | string) => retainedReplies.get(id)?.(value),
    replaceDraft: () => (draft = "replacement client's draft"),
    get draft() {
      return draft;
    },
    get writes() {
      return writes;
    },
    get retiredReads() {
      return retiredReads;
    },
  };
}

test("shutdown cancels RPC confirmation without a client response and settles /code", async () => {
  const host = hostFixture();
  const old = host.context();
  const command = host.command("last insert 1", old.ctx);
  assert.equal(host.pending.size, 1);
  assert.notEqual(host.signals[0], host.agentSignal);
  old.retire();
  host.emit("session_shutdown");
  assert.equal(host.pending.size, 0);
  assert.equal(host.signals[0]?.aborted, true);
  assert.equal(host.agentSignal.aborted, false);
  await command;
  host.reply(1, true);
  assert.equal(host.writes, 0);
  assert.deepEqual(host.notices, []);
  assert.equal(host.retiredReads, 0);
}, 1000);

for (const event of [
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_start",
  "session_tree",
]) {
  test(`${event} retires RPC insertion; a late yes cannot replace the new client's draft`, async () => {
    const host = hostFixture();
    const old = host.context();
    const command = host.command("last insert 1", old.ctx);
    old.retire();
    host.emit(event);
    host.replaceDraft();
    assert.equal(host.pending.size, 0);
    host.reply(1, true);
    await command;
    assert.equal(host.draft, "replacement client's draft");
    assert.equal(host.writes, 0);
    assert.deepEqual(host.notices, []);
    assert.equal(host.retiredReads, 0);

    // Retiring pending work does not disable valid operations in the new session/branch.
    const next = host.context("new-session", "new-leaf");
    const valid = host.command("last insert 1", next.ctx);
    host.reply(2, true);
    await valid;
    assert.equal(host.draft, "const a = 1;");
    assert.equal(host.writes, 1);
    assert.deepEqual(host.notices, ["Inserted snippet into editor."]);
  }, 1000);
}

test("yes already resolved before shutdown still cannot write or notify from the retired context", async () => {
  const host = hostFixture();
  const old = host.context();
  const command = host.command("last insert 1", old.ctx);
  host.reply(1, true);
  old.retire();
  host.emit("session_shutdown");
  host.replaceDraft();
  await command;
  assert.equal(host.draft, "replacement client's draft");
  assert.equal(host.writes, 0);
  assert.deepEqual(host.notices, []);
  assert.equal(host.retiredReads, 0);
});

test("a different captured session or leaf retires a pending command even before a committed event", async () => {
  for (const [sessionId, leafId] of [
    ["new-session", "a"],
    ["session", "new-leaf"],
  ]) {
    const host = hostFixture();
    const old = host.context();
    const previous = host.command("last insert 1", old.ctx);
    old.retire();
    const next = host.command("last insert 1", host.context(sessionId, leafId).ctx);
    assert.equal(host.signals[0]?.aborted, true);
    assert.equal(host.pending.size, 1);
    host.reply(1, true);
    await previous;
    assert.equal(host.writes, 0);
    assert.deepEqual(host.notices, []);
    host.reply(2, true);
    await next;
    assert.equal(host.writes, 1);
    assert.equal(host.retiredReads, 0);
  }
});

test("unchanged RPC ownership keeps consent explicit and emits exactly one replacement", async () => {
  const host = hostFixture();
  const current = host.context();
  const declined = host.command("last insert 1", current.ctx);
  host.reply(1, false);
  await declined;
  assert.equal(host.writes, 0);
  assert.equal(host.draft, "client draft");
  assert.deepEqual(host.notices, []);
  const accepted = host.command("last insert 1", current.ctx);
  assert.equal(host.signals[0], host.signals[1]);
  host.reply(2, true);
  await accepted;
  assert.equal(host.draft, "const a = 1;");
  assert.equal(host.writes, 1);
  assert.deepEqual(host.notices, ["Inserted snippet into editor."]);
});

for (const event of [
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_tree",
  "session_start",
  "session_shutdown",
]) {
  for (const lateAction of ["Copy", "Insert", "Run"]) {
    test(`${event} settles index-only RPC /code without a reply; late ${lateAction} is inert`, async () => {
      const host = hostFixture();
      const old = host.context();
      const pending = host.command("last 1", old.ctx);
      assert.equal(host.pending.size, 1);
      assert.equal(host.signals.length, 1);
      old.retire();
      host.emit(event);
      host.replaceDraft();
      assert.equal(host.pending.size, 0);
      assert.equal(host.signals[0]?.aborted, true);
      await pending;
      host.reply(1, lateAction);
      assert.equal(host.draft, "replacement client's draft");
      assert.equal(host.writes, 0);
      assert.equal(host.retiredReads, 0);
      assert.deepEqual(host.execs, []);
      assert.deepEqual(host.notices, []);
    }, 1000);
  }
}

test("normal RPC action selection retains draft consent and runs only after confirmation", async () => {
  const snippet = process.platform === "win32" ? "Write-Output 'confirmed snippet'" : "printf 'confirmed snippet';";
  const host = hostFixture(undefined, snippet);
  const current = host.context();
  const inserting = host.command("last 1", current.ctx);
  host.reply(1, "Insert");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(host.pending.size, 1);
  assert.equal(host.writes, 0);
  host.reply(2, true);
  await inserting;
  assert.equal(host.writes, 1);
  const running = host.command("last 1", current.ctx);
  host.reply(3, "Run");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(host.execs, []);
  host.reply(4, true);
  await running;
  assert.deepEqual(host.execs, [], "full-shell snippets must not use Pi's parent-only exec cancellation");
  assert.match(host.notices.at(-1) ?? "", /confirmed snippet/);
  assert.match(host.notices.at(-1) ?? "", /Exit code: 0/);
});

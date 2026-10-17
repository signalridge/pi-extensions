import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vitest";
import { Owner } from "../src/ownership.js";
import { deferred, fixture, model } from "./support.js";

// Exercise actual SDK command ownership rather than only mock contexts.
test("retirement cancels live synthesis; provider result cannot open review or create destination", async () => {
  const f = await fixture();
  const stream = createAssistantMessageEventStream();
  const entered = deferred<void>();
  let requestSignal: AbortSignal | undefined;
  try {
    f.source.extensionRunner.createCommandContext().modelRegistry.streamSimple = (_model, _context, options) => {
      requestSignal = options?.signal;
      entered.resolve();
      return stream;
    };
    f.editorResults.push("reviewed context", "must never become summary");
    const running = f.command("handoff", "continue");
    await entered.promise;
    await f.source.extensionRunner.emit({
      type: "model_select",
      model: { ...model, id: "different" },
      previousModel: model,
      source: "set",
    });
    await running;
    expect(requestSignal?.aborted).toBe(true);
    expect(f.editors.length).toBe(1);
    expect(f.withSessions).toBe(0);
    expect(f.runtime.session).toBe(f.source);
    expect(f.destinationTurns).toBe(0);
  } finally {
    stream.end();
    await f.cleanup();
  }
});

test("RPC late multiline-editor response is ignored after native navigation attempt, even when vetoed", async () => {
  const f = await fixture({ extra: (pi) => pi.on("session_before_switch", () => ({ cancel: true })) });
  const entered = deferred<void>();
  const editor = deferred<string>();
  try {
    f.confirmationResults.push(false, true); // no generation; manual
    f.ui.editor = async () => {
      entered.resolve();
      return editor.promise;
    };
    const running = f.command("handoff", "continue");
    await entered.promise;
    const switched = await f.runtime.newSession();
    expect(switched.cancelled).toBe(true);
    f.editorText = "newer client draft";
    await running;
    editor.resolve("late manual summary");
    await editor.promise;
    await Promise.resolve();
    expect(f.editorText).toBe("newer client draft");
    expect(f.runtime.session).toBe(f.source);
    expect(f.withSessions).toBe(0);
    expect(f.destinationTurns).toBe(0);
  } finally {
    editor.resolve("late");
    await f.cleanup();
  }
});

test("branch/manager change while waitForIdle is pending invalidates command intent before dialogs", async () => {
  const f = await fixture();
  const idle = deferred<void>();
  const entered = deferred<void>();
  try {
    vi.spyOn(f.source, "waitForIdle").mockImplementation(() => {
      entered.resolve();
      return idle.promise;
    });
    const running = f.command("handoff", "continue");
    await entered.promise;
    f.manager.appendCustomEntry("later native entry");
    idle.resolve();
    await running;
    expect(f.editors.length).toBe(0);
    expect(f.confirmations.length).toBe(0);
    expect(f.generationCalls).toBe(0);
    expect(f.withSessions).toBe(0);
  } finally {
    idle.resolve();
    await f.cleanup();
  }
});

test("same-ID model configuration or ancestor native data changes retire ownership", async () => {
  const f = await fixture();
  try {
    let selected = { ...model };
    const ctx = {
      ...f.source.extensionRunner.createCommandContext(),
      get model() {
        return selected;
      },
    };
    const modelOwner = new Owner(ctx, true);
    selected = { ...selected, baseUrl: "http://changed.invalid" };
    expect(modelOwner.current()).toBe(false);
    selected = { ...model };
    expect(modelOwner.current()).toBe(false);
    const branchOwner = new Owner(ctx, true);
    const leaf = f.manager.getLeafId();
    const root = f.manager.getBranch()[0];
    if (root.type === "message" && root.message.role === "user") root.message.content = "changed ancestor";
    expect(f.manager.getLeafId()).toBe(leaf);
    expect(branchOwner.current()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("an unwritten persistent source path gets a private native snapshot, not a broken parent link", async () => {
  const f = await fixture();
  try {
    f.manager.newSession(); // native header allocated but not written
    f.manager.appendCustomEntry("private nonempty source", { data: "retained only in parent" });
    f.editorResults.push("manual summary");
    await f.command("handoff", "continue manually");
    const header = f.runtime.session.sessionManager.getHeader();
    expect(header?.parentSession).toContain("pi-sessions-parent-");
    expect(f.destinationTurns).toBe(0);
  } finally {
    await f.cleanup();
  }
});

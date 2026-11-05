import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import planMode from "../src/plan-mode.js";

async function fixture(
  earlier: (pi: ExtensionAPI) => void = () => {},
  retention?: "clear-on-start" | "clear-after-first-run",
) {
  const cwd = mkdtempSync(join(tmpdir(), "plan-retirement-sdk-"));
  const faux = fauxProvider({ provider: "plan-retirement-faux", models: [{ id: "test", contextWindow: 200_000 }] });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const manager = SessionManager.inMemory(cwd);
  let api!: ExtensionAPI;
  const sent: string[] = [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      { name: "earlier", factory: earlier },
      {
        name: "plan",
        factory: (pi) => {
          api = pi;
          planMode(pi, {
            readSettings: async () =>
              retention
                ? { kind: "loaded", settings: { thinkingLevel: "inherit", implementationPlanRetention: retention } }
                : { kind: "missing" },
          });
          pi.sendUserMessage = (text) => {
            sent.push(typeof text === "string" ? text : JSON.stringify(text));
          };
        },
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    modelRegistry: registry,
    model: registry.find("plan-retirement-faux", "test"),
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      images: { autoResize: false },
    }),
  });
  await session.bindExtensions({ mode: "rpc" });
  const command = (args: string) =>
    session.extensionRunner.getCommand("plan")?.handler(args, session.extensionRunner.createCommandContext());
  const state = () =>
    manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state")
      .at(-1)?.data;
  return {
    session,
    command,
    manager,
    api,
    faux,
    state,
    sent,
    registry: session.extensionRunner.getModelRegistry(),
    async close() {
      await session.dispose();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const retention of ["clear-on-start", "clear-after-first-run"] as const) {
  test(`automatic ${retention} cleanup does not cancel the accepted handoff's first request`, async () => {
    const f = await fixture(undefined, retention);
    try {
      let tools = 0;
      f.api.registerTool({
        name: "probe",
        label: "Probe",
        description: "Substantive probe",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          tools++;
          return { content: [], details: undefined };
        },
      });
      await f.command("start");
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# First implementation context" }), {
          stopReason: "toolUse",
        }),
      ]);
      await f.session.prompt("Plan it", { source: "rpc" });
      await f.command("implement");
      const owned = f.sent.at(-1);
      if (!owned) throw new Error("handoff missing");
      const contexts: TranscriptContext[] = [];
      f.faux.setResponses([
        (ctx) => {
          contexts.push(ctx);
          return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
        },
        fauxAssistantMessage("implemented"),
      ]);
      await f.session.prompt(owned, { source: "extension" });
      expect(contexts).toHaveLength(1);
      expect(JSON.stringify(contexts)).toContain("First implementation context");
      expect(tools).toBe(1);
      expect((f.state() as { activeImplementation?: unknown }).activeImplementation).toBeUndefined();
    } finally {
      await f.close();
    }
  });
}

for (const retirement of ["exit", "start"]) {
  test(`owned handoff intercepted before ${retirement} cannot reach the provider as an instruction`, async () => {
    const f = await fixture();
    const entered = gate();
    const held = gate();
    try {
      let tools = 0;
      f.api.registerTool({
        name: "probe",
        label: "Probe",
        description: "Substantive probe",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          tools++;
          return { content: [], details: undefined };
        },
      });
      await f.command("start");
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Retired private plan" }), {
          stopReason: "toolUse",
        }),
      ]);
      await f.session.prompt("Plan it", { source: "rpc" });
      await f.command("implement");
      const owned = f.sent.at(-1);
      if (!owned) throw new Error("handoff was not sent");
      f.api.on("input", async (event) => {
        if (event.text === owned && event.source === "extension") {
          entered.release();
          await held.promise;
        }
      });
      const contexts: string[] = [];
      f.faux.setResponses([
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
        },
      ]);
      const prompt = f.session.prompt(owned, { source: "extension" });
      await entered.promise;
      await f.command(retirement);
      held.release();
      await prompt;
      expect(contexts).toHaveLength(0);
      expect(tools).toBe(0);
      if (retirement === "exit") expect(contexts.join()).not.toContain("Retired private plan");
      expect(contexts.join()).not.toContain("Implement this proposed plan now");
      const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
      f.faux.setResponses([
        (ctx) => {
          expect(ctx.messages.filter((m) => m.role === "user").at(-1)?.content).toEqual([
            { type: "text", text: owned },
            ...images,
          ]);
          return fauxAssistantMessage("literal");
        },
      ]);
      await f.session.prompt(owned, { source: "rpc", images });
      expect(f.session.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([
        { type: "text", text: owned },
        ...images,
      ]);
      f.faux.setResponses([
        (ctx) => {
          expect(ctx.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([
            { type: "text", text: owned },
          ]);
          return fauxAssistantMessage("literal without images");
        },
      ]);
      await f.session.prompt(owned, { source: "rpc" });
    } finally {
      held.release();
      await f.close();
    }
  });
}

for (const variant of ["planning", "ready", "implementation"] as const) {
  test(`committed tree target is authoritative before a delayed tree handler: ${variant}`, async () => {
    const inputEntered = gate();
    const inputHeld = gate();
    const treeEntered = gate();
    const treeHeld = gate();
    const f = await fixture((pi) => {
      pi.on("input", async (event) => {
        if (event.text === "B user input") {
          inputEntered.release();
          await inputHeld.promise;
        }
      });
      pi.on("session_tree", async () => {
        treeEntered.release();
        await treeHeld.promise;
      });
    });
    try {
      const root = f.manager.appendCustomEntry("root", {});
      const B = f.manager.appendCustomEntry("metadata", { branch: "B" });
      f.manager.branch(root);
      f.manager.appendCustomEntry("metadata", { branch: "A" });
      await f.command("start");
      if (variant !== "planning") {
        f.faux.setResponses([
          fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# A only plan" }), {
            stopReason: "toolUse",
          }),
        ]);
        await f.session.prompt("Plan A", { source: "rpc" });
      }
      if (variant === "implementation") await f.command("implement");
      const A = f.manager.getLeafId();
      if (!A) throw new Error("A branch is missing");
      const originalState = JSON.stringify(f.state());
      const contexts: string[] = [];
      f.faux.setResponses([
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage("ordinary B");
        },
      ]);
      const prompt = f.session.prompt("B user input", { source: "rpc" });
      await inputEntered.promise;
      const navigation = f.session.navigateTree(B);
      await treeEntered.promise;
      expect(f.manager.getLeafId()).toBe(B);
      inputHeld.release();
      await prompt;
      expect(f.state()).toBeUndefined();
      expect(f.session.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([
        { type: "text", text: "B user input" },
      ]);
      expect(contexts.join()).not.toContain("A only plan");
      expect(contexts.join()).not.toContain("You are in Plan mode");
      treeHeld.release();
      await navigation;
      expect(f.state()).toBeUndefined();
      await f.session.navigateTree(A);
      expect(JSON.stringify(f.state())).toBe(originalState);
    } finally {
      inputHeld.release();
      treeHeld.release();
      await f.close();
    }
  });
}

for (const retirement of ["exit", "off", "cancel"] as const) {
  test(`accepted uncommitted handoff survives later message_start retirement: ${retirement}`, async () => {
    const f = await fixture();
    const entered = gate();
    const held = gate();
    try {
      let tools = 0;
      f.api.registerTool({
        name: "probe",
        label: "Probe",
        description: "Substantive probe",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          tools++;
          return { content: [], details: undefined };
        },
      });
      await f.command("start");
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Uncommitted private plan" }), {
          stopReason: "toolUse",
        }),
      ]);
      await f.session.prompt("Plan it", { source: "rpc" });
      await f.command("implement");
      const owned = f.sent.at(-1);
      if (!owned) throw new Error("handoff missing");
      f.api.on("message_start", async (event) => {
        if (event.message.role === "user" && JSON.stringify(event.message.content).includes("pi-plan-delivery")) {
          entered.release();
          await held.promise;
        }
      });
      const contexts: string[] = [];
      f.faux.setResponses([
        (ctx) => {
          contexts.push(JSON.stringify(ctx));
          return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
        },
      ]);
      const prompt = f.session.prompt(owned, { source: "extension" });
      await entered.promise;
      expect(
        f.manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "user" &&
              JSON.stringify(entry.message.content) === JSON.stringify([{ type: "text", text: owned }]),
          ),
      ).toBe(false);
      const canceled = retirement === "cancel" ? f.session.abort() : undefined;
      await f.command(retirement === "cancel" ? "exit" : retirement);
      held.release();
      await prompt;
      await canceled;
      expect(contexts).toHaveLength(0);
      expect(tools).toBe(0);
      for (const images of [[], [{ type: "image" as const, data: "AA==", mimeType: "image/png" }]]) {
        const controls: TranscriptContext[] = [];
        f.faux.setResponses([
          (ctx) => {
            controls.push(ctx);
            return fauxAssistantMessage("ordinary");
          },
        ]);
        await f.session.prompt("Genuine user", { source: "rpc", images });
        expect(controls).toHaveLength(1);
        expect(controls[0]?.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([
          { type: "text", text: "Genuine user" },
          ...images,
        ]);
        f.faux.setResponses([
          (ctx) => {
            controls.push(ctx);
            return fauxAssistantMessage("literal");
          },
        ]);
        await f.session.prompt(owned, { source: "rpc", images });
        expect(controls).toHaveLength(2);
        expect(controls[1]?.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([
          { type: "text", text: owned },
          ...images,
        ]);
      }
    } finally {
      held.release();
      await f.close();
    }
  });
}

for (const reload of [false, true])
  test(`expired owned acceptance after a later input barrier is denied, literals and foreign tokens survive: reload=${reload}`, async () => {
    const f = await fixture();
    const entered = gate();
    const held = gate();
    try {
      await f.command("start");
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Expired private plan" }), {
          stopReason: "toolUse",
        }),
      ]);
      await f.session.prompt("Plan it", { source: "rpc" });
      await f.command("implement");
      const owned = f.sent.at(-1);
      if (!owned) throw new Error("handoff missing");
      f.api.on("input", async (event) => {
        if (event.source === "extension" && event.text === owned) {
          entered.release();
          await held.promise;
        }
      });
      let requests = 0;
      let tools = 0;
      f.api.registerTool({
        name: "probe",
        label: "Probe",
        description: "Substantive probe",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          tools++;
          return { content: [], details: undefined };
        },
      });
      f.faux.setResponses([
        () => {
          requests++;
          return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
        },
      ]);
      const prompt = f.session.prompt(owned, { source: "extension" });
      await entered.promise;
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 300_001);
      await f.command("exit");
      if (reload) await f.session.reload();
      held.release();
      await prompt;
      expect(requests).toBe(0);
      expect(tools).toBe(0);
      const retiredNative = f.session.messages.filter((message) => message.role === "user").at(-1);
      expect(retiredNative?.content).toEqual([{ type: "text", text: owned }]);
      // Retired context proofs must not themselves expire while a handler awaits.
      vi.spyOn(Date, "now").mockReturnValue(now + 900_001);
      for (const source of ["rpc", "extension"] as const) {
        const text = source === "rpc" ? owned : owned.replace(/([a-f0-9]{64}) -->$/u, `${"0".repeat(64)} -->`);
        for (const images of [[], [{ type: "image" as const, data: "AA==", mimeType: "image/png" }]]) {
          const controls: TranscriptContext[] = [];
          f.faux.setResponses([
            (ctx) => {
              controls.push(ctx);
              return fauxAssistantMessage("literal or foreign");
            },
          ]);
          await f.session.prompt(text, { source, images });
          expect(controls).toHaveLength(1);
          expect(controls[0]?.messages.filter((message) => message.role === "user").at(-1)?.content).toEqual([
            { type: "text", text },
            ...images,
          ]);
          expect(
            controls[0]?.messages.some(
              (message) =>
                message.role === "user" &&
                message.timestamp === retiredNative?.timestamp &&
                JSON.stringify(message.content).includes("Expired private plan"),
            ),
          ).toBe(false);
        }
      }
    } finally {
      vi.restoreAllMocks();
      held.release();
      await f.close();
    }
  });

for (const boundary of ["input", "context"] as const) {
  test(`descendant state source fences ancestor cache before delayed tree notification: ${boundary}`, async () => {
    const entered = gate();
    const held = gate();
    const treeEntered = gate();
    const treeHeld = gate();
    let holdTree = false;
    let holdRun = false;
    const f = await fixture((pi) => {
      pi.on(boundary, async () => {
        if (holdRun) {
          entered.release();
          await held.promise;
        }
      });
      pi.on("session_tree", async () => {
        if (holdTree) {
          treeEntered.release();
          await treeHeld.promise;
        }
      });
    });
    try {
      await f.command("start");
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Ancestor plan1" }), {
          stopReason: "toolUse",
        }),
      ]);
      await f.session.prompt("Plan A", { source: "rpc" });
      await f.command("implement");
      const A = f.manager.getLeafId();
      if (!A) throw new Error("A missing");
      await f.command("start");
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Descendant plan2" }), {
          stopReason: "toolUse",
        }),
      ]);
      await f.session.prompt("Plan B", { source: "rpc" });
      await f.command("implement");
      const B = f.manager.getLeafId();
      if (!B) throw new Error("B missing");
      const originalB = JSON.stringify(f.state());
      await f.session.navigateTree(A);
      expect(JSON.stringify(f.state())).toContain("Ancestor plan1");
      // Ordinary full-prefix appends do not invalidate Plan's state source.
      f.manager.appendCustomEntry("ordinary-metadata", { value: 1 });
      const controls: TranscriptContext[] = [];
      f.faux.setResponses([
        (ctx) => {
          controls.push(ctx);
          return fauxAssistantMessage("append control");
        },
      ]);
      await f.session.prompt("ordinary append control", { source: "extension" });
      expect(controls).toHaveLength(1);
      expect(
        controls[0]?.messages.some(
          (message) =>
            JSON.stringify(message.content).includes("[ACTIVE IMPLEMENTATION PLAN]") &&
            JSON.stringify(message.content).includes("Ancestor plan1"),
        ),
      ).toBe(true);
      await f.session.navigateTree(A);
      holdRun = true;
      const contexts: TranscriptContext[] = [];
      f.faux.setResponses([
        (ctx) => {
          contexts.push(ctx);
          return fauxAssistantMessage("B response");
        },
      ]);
      // SDK disallows navigation during an active response. For context,
      // start the target request after navigation commits, while TREE awaits.
      let prompt: Promise<void>;
      let navigation: ReturnType<typeof f.session.navigateTree>;
      if (boundary === "input") {
        prompt = f.session.prompt("B input", { source: "rpc" });
        await entered.promise;
        holdTree = true;
        navigation = f.session.navigateTree(B);
        await treeEntered.promise;
      } else {
        holdTree = true;
        navigation = f.session.navigateTree(B);
        await treeEntered.promise;
        prompt = f.session.prompt("B input", { source: "rpc" });
        await entered.promise;
      }
      expect(f.manager.getBranch().some((entry) => entry.id === B)).toBe(true);
      if (boundary === "input") await f.command("exit");
      expect(JSON.stringify(f.state())).toBe(originalB);
      held.release();
      await prompt;
      expect(JSON.stringify(f.state())).toBe(originalB);
      expect(contexts).toHaveLength(1);
      expect(
        contexts[0]?.messages.some(
          (message) =>
            JSON.stringify(message.content).includes("[ACTIVE IMPLEMENTATION PLAN]") &&
            JSON.stringify(message.content).includes("Ancestor plan1"),
        ),
      ).toBe(false);
      treeHeld.release();
      await navigation;
    } finally {
      held.release();
      treeHeld.release();
      await f.close();
    }
  });
}

test("equal state payload on a distinct descendant native entry is a different authority", async () => {
  const entered = gate();
  const held = gate();
  let holding = false;
  const f = await fixture((pi) => {
    pi.on("session_tree", async () => {
      if (holding) {
        entered.release();
        await held.promise;
      }
    });
  });
  try {
    await f.command("start");
    const A = f.manager.getLeafId();
    if (!A) throw new Error("A missing");
    const B = f.manager.appendCustomEntry("plan-mode-state", structuredClone(f.state()));
    await f.session.navigateTree(A);
    holding = true;
    const navigation = f.session.navigateTree(B);
    await entered.promise;
    await f.command("exit");
    expect(f.manager.getLeafId()).toBe(B);
    const contexts: TranscriptContext[] = [];
    f.faux.setResponses([
      (ctx) => {
        contexts.push(ctx);
        return fauxAssistantMessage("ordinary target");
      },
    ]);
    await f.session.prompt("Real target input", { source: "rpc" });
    expect(contexts).toHaveLength(1);
    expect(JSON.stringify(contexts)).not.toContain("You are in Plan mode");
    expect(f.state()).toMatchObject({ enabled: true });
    held.release();
    await navigation;
  } finally {
    held.release();
    await f.close();
  }
});

const nativeJSON = JSON as typeof JSON & { rawJSON(text: string): object };
for (const payload of ['"text"', "1", "null"]) {
  for (const reverse of [false, true]) {
    test.skipIf(typeof nativeJSON.rawJSON !== "function")(
      `warm fingerprints cannot transfer completion across native tool_call RawJSON ${payload} prefix replacement (reverse=${reverse})`,
      async () => {
        const f = await fixture();
        try {
          const raw = nativeJSON.rawJSON(payload);
          const plain = Object.create(Object.getPrototypeOf(raw), Object.getOwnPropertyDescriptors(raw));
          const prefix = { data: reverse ? raw : plain };
          f.manager.appendCustomEntry("opaque-prefix", prefix);
          const entry = f.manager.getBranch()[0];
          const id = entry.id;
          await f.command("start");
          let changed = false;
          f.api.on("tool_call", (event) => {
            if (event.toolName !== "plan_mode_complete" || changed) return;
            changed = true;
            prefix.data = reverse ? plain : raw;
          });
          f.faux.setResponses([
            fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Must not commit RawJSON" }), {
              stopReason: "toolUse",
            }),
            fauxAssistantMessage("ordinary"),
          ]);
          await f.session.prompt("Plan it", { source: "rpc" });
          expect(changed).toBe(true);
          expect(f.manager.getBranch()[0]).toBe(entry);
          expect(entry.id).toBe(id);
          expect(JSON.stringify(f.state()) ?? "").not.toContain("Must not commit RawJSON");
          expect(
            f.manager
              .getBranch()
              .some(
                (item) =>
                  item.type === "custom" &&
                  item.customType === "plan-mode-state" &&
                  JSON.stringify(item.data).includes("Must not commit RawJSON"),
              ),
          ).toBe(false);
        } finally {
          await f.close();
        }
      },
    );
  }
}

for (const boundary of [
  "deep-prefix",
  "boxed-prefix",
  "array-impostor",
  "state-metadata",
  "root",
  "session",
] as const) {
  test(`warm fingerprints cannot transfer a completion across a later native tool_call ${boundary} mutation`, async () => {
    const f = await fixture();
    try {
      const opaque = { nested: { text: "original" }, data: {} as unknown, array: [] as unknown };
      f.manager.appendCustomEntry("opaque-prefix", opaque);
      await f.command("start");
      let changed = false;
      f.api.on("tool_call", (event) => {
        if (event.toolName !== "plan_mode_complete" || changed) return;
        changed = true;
        if (boundary === "deep-prefix") opaque.nested.text = "same object changed";
        if (boundary === "boxed-prefix") opaque.data = Object.setPrototypeOf(new Boolean(true), Object.prototype);
        if (boundary === "array-impostor") opaque.array = Object.create(Array.prototype);
        if (boundary === "state-metadata") Reflect.set(f.state() as object, "metadata", { changed: true });
        if (boundary === "root") f.manager.resetLeaf();
        if (boundary === "session") f.manager.newSession();
      });
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Must not commit" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("ordinary"),
      ]);
      await f.session.prompt("Plan it", { source: "rpc" });
      expect(changed).toBe(true);
      expect(JSON.stringify(f.state()) ?? "").not.toContain("Must not commit");
      expect(
        f.manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "plan-mode-state" &&
              JSON.stringify(entry.data).includes("Must not commit"),
          ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
}

test("cancelled native navigation preserves a warmed branch and its next accepted revision", async () => {
  const f = await fixture();
  try {
    const root = f.manager.appendCustomEntry("root", {});
    await f.command("start");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Ready before cancel" }), {
        stopReason: "toolUse",
      }),
    ]);
    await f.session.prompt("Plan it", { source: "rpc" });
    const leaf = f.manager.getLeafId();
    f.api.on("session_before_tree", () => ({ cancel: true }));
    expect((await f.session.navigateTree(root)).cancelled).toBe(true);
    expect(f.manager.getLeafId()).toBe(leaf);
    expect(f.state()).toMatchObject({ latestPlan: "# Ready before cancel" });
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Accepted after cancel" }), {
        stopReason: "toolUse",
      }),
    ]);
    await f.session.prompt("Revise it", { source: "rpc" });
    expect(f.state()).toMatchObject({ latestPlan: "# Accepted after cancel" });
  } finally {
    await f.close();
  }
});

test("late saved-plan authentication cannot transition a committed different branch or discard the source plan", async () => {
  const treeEntered = gate();
  const treeHeld = gate();
  const authEntered = gate();
  const authHeld = gate();
  const f = await fixture((pi) => {
    pi.on("session_tree", async () => {
      treeEntered.release();
      await treeHeld.promise;
    });
  });
  try {
    const root = f.manager.appendCustomEntry("root", {});
    const B = f.manager.appendCustomEntry("metadata", { branch: "B" });
    f.manager.branch(root);
    f.manager.appendCustomEntry("metadata", { branch: "A" });
    await f.command("start");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Saved A" }), { stopReason: "toolUse" }),
    ]);
    await f.session.prompt("Plan A", { source: "rpc" });
    await f.command("save");
    const A = f.manager.getLeafId();
    if (!A) throw new Error("A branch is missing");
    const original = JSON.stringify(f.state());
    f.registry.getApiKeyAndHeaders = async () => {
      authEntered.release();
      await authHeld.promise;
      return { ok: true };
    };
    const implementing = f.command("implement");
    await Promise.race([
      authEntered.promise,
      Promise.resolve(implementing).then(() => {
        throw new Error("implementation did not enter auth preflight");
      }),
    ]);
    const navigation = f.session.navigateTree(B);
    await treeEntered.promise;
    authHeld.release();
    await implementing;
    expect(f.sent).toHaveLength(0);
    expect(f.state()).toBeUndefined();
    treeHeld.release();
    await navigation;
    await f.session.navigateTree(A);
    expect(JSON.stringify(f.state())).toBe(original);
  } finally {
    authHeld.release();
    treeHeld.release();
    await f.close();
  }
});

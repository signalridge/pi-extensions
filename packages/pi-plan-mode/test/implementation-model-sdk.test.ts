import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import type { PlanModeSettings } from "../src/settings.js";

const PROVIDER = "plan-model-faux";
const LOCKED = "plan-model-locked";
const planner = { provider: PROVIDER, id: "planner" };
const builder = { provider: PROVIDER, id: "builder" };

type Notification = { message: string; level?: string };

async function fixture(
  settings: Partial<PlanModeSettings>,
  options: {
    cwd?: string;
    sessionFile?: string;
    setModel?: (original: ExtensionAPI["setModel"]) => ExtensionAPI["setModel"];
    probe?: (pi: ExtensionAPI) => void;
    beforePlan?: (pi: ExtensionAPI) => void;
    afterPlan?: (pi: ExtensionAPI) => void;
  } = {},
) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "plan-model-sdk-"));
  const sessionDir = join(cwd, "sessions");
  const faux = fauxProvider({
    provider: PROVIDER,
    models: ["planner", "builder", "reviewer"].map((id) => ({
      id,
      reasoning: true,
      contextWindow: 200_000,
    })),
  });
  const locked = fauxProvider({
    provider: LOCKED,
    models: [{ id: "builder", reasoning: true }],
  });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  runtime.registerNativeProvider({
    ...locked.provider,
    auth: { apiKey: { name: "Locked", resolve: async () => undefined } },
  });
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const manager = options.sessionFile
    ? SessionManager.open(options.sessionFile, sessionDir)
    : SessionManager.create(cwd, sessionDir);
  const sent: string[] = [];
  const answeredBy: string[] = [];
  const notifications: Notification[] = [];
  const errors: unknown[] = [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      ...(options.beforePlan ? [{ name: "earlier", factory: options.beforePlan }] : []),
      {
        name: "plan",
        factory: (pi) => {
          if (options.setModel) pi.setModel = options.setModel(pi.setModel.bind(pi));
          planMode(pi, {
            readSettings: async () => ({
              kind: "loaded",
              settings: { thinkingLevel: "inherit", ...settings },
            }),
          });
          options.probe?.(pi);
          pi.sendUserMessage = (text) => {
            sent.push(typeof text === "string" ? text : JSON.stringify(text));
          };
        },
      },
      ...(options.afterPlan ? [{ name: "later", factory: options.afterPlan }] : []),
    ],
  });
  await loader.reload();
  const hostSettings = SettingsManager.inMemory({
    defaultThinkingLevel: "medium",
    compaction: { enabled: false },
    retry: { enabled: false },
    images: { autoResize: false },
  });
  // Default to unambiguous switches: the model switch itself keeps thinking
  // unchanged, leaving Plan's explicit low/high setters solely responsible.
  hostSettings.setModelThinkingLevel(PROVIDER, "builder", "high");
  hostSettings.setModelThinkingLevel(PROVIDER, "planner", "low");
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    modelRegistry: registry,
    // A resumed session restores its model and thinking level from the branch.
    ...(options.sessionFile
      ? {}
      : {
          model: registry.find(PROVIDER, "planner"),
          thinkingLevel: "high" as const,
        }),
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: hostSettings,
  });
  // Dialogs dismiss immediately: these tests drive /plan subcommands, not menus.
  const ui = {
    notify: (message: string, level?: string) => notifications.push({ message, level }),
    setStatus: () => undefined,
    setWidget: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
  };
  await session.bindExtensions({ mode: "rpc", uiContext: ui as never, onError: (error) => errors.push(error) });
  const command = async (args: string) => {
    await session.extensionRunner.getCommand("plan")?.handler(args, session.extensionRunner.createCommandContext());
  };
  const state = () =>
    manager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state")
      .at(-1)?.data as Record<string, unknown> | undefined;
  const respond = (text: string) =>
    faux.setResponses([
      (_context, _options, _state, model) => {
        answeredBy.push(model.id);
        return fauxAssistantMessage(text);
      },
    ]);
  return {
    cwd,
    session,
    manager,
    registry,
    command,
    state,
    sent,
    answeredBy,
    notifications,
    respond,
    current: () => ({
      model: session.model?.id,
      thinking: session.thinkingLevel,
    }),
    async planReady() {
      await command("start");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: "# Build it" }), { stopReason: "toolUse" }),
      ]);
      await session.prompt("Plan it", { source: "rpc" });
      assert.equal(state()?.awaitingAction, true);
    },
    /** Deliver the owned handoff the way Pi would after `sendUserMessage`. */
    async runHandoff() {
      const owned = sent.at(-1);
      if (!owned) throw new Error("implementation handoff was not sent");
      respond("implemented");
      await session.prompt(owned, { source: "extension" });
    },
    async close(keep = false) {
      await session.dispose();
      if (!keep) rmSync(cwd, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    },
  };
}

const configured = {
  implementationModel: `${PROVIDER}/builder`,
  implementationThinkingLevel: "low" as const,
};

test("Implement here runs on the implementation model and /plan exit restores the planning model", async () => {
  const f = await fixture(configured);
  try {
    await f.planReady();
    assert.deepEqual(f.current(), { model: "planner", thinking: "high" });

    await f.command("implement");
    assert.deepEqual(f.current(), { model: "builder", thinking: "low" });
    assert.deepEqual(f.state()?.modelHandoff, {
      appliedModel: builder,
      previousModel: planner,
      previousThinkingLevel: "high",
      appliedThinkingLevel: "low",
    });
    assert.match(f.notifications.at(-1)?.message ?? "", /Implementing on plan-model-faux\/builder\./);
    await f.runHandoff();
    assert.deepEqual(f.answeredBy, ["builder"]);

    await f.command("exit");
    assert.deepEqual(f.current(), { model: "planner", thinking: "high" });
    assert.equal(f.state()?.modelHandoff, undefined);
    assert.equal(f.notifications.at(-1)?.message, `Restored planning model ${PROVIDER}/planner.`);
  } finally {
    await f.close();
  }
});

test("a new plan returns to the planning model before Plan thinking is applied", async () => {
  const f = await fixture({ ...configured, thinkingLevel: "minimal" });
  try {
    await f.planReady();
    assert.deepEqual(f.current(), { model: "planner", thinking: "minimal" });
    await f.command("implement");
    assert.deepEqual(f.current(), { model: "builder", thinking: "low" });
    await f.runHandoff();
    f.respond("planning again");
    await f.command("Plan the follow-up");
    assert.deepEqual(f.current(), { model: "planner", thinking: "minimal" });
    const owned = f.sent.at(-1);
    if (!owned) throw new Error("planning prompt was not sent");
    await f.session.prompt(owned, { source: "extension" });
    assert.deepEqual(f.answeredBy, ["builder", "planner"]);
    assert.equal(f.state()?.enabled, true);
    assert.equal(f.state()?.modelHandoff, undefined);
    // Plan thinking snapshotted the restored planning level, not the implementation one.
    await f.command("exit");
    assert.deepEqual(f.current(), { model: "planner", thinking: "high" });
  } finally {
    await f.close();
  }
});

test("a model or thinking level chosen during implementation is the user's to keep", async () => {
  for (const choice of ["model", "model-and-back", "tree", "thinking"] as const) {
    const f = await fixture(configured);
    try {
      await f.planReady();
      await f.command("implement");
      const handoffEntry = f.manager.getLeafId();
      if (choice === "thinking") {
        f.session.setThinkingLevel("minimal");
        // With no automatic transition on return, Plan can preserve the
        // selected level without an ambiguous model-default event.
        f.session.settingsManager.setModelThinkingLevel(PROVIDER, "planner", "minimal");
      } else {
        const reviewer = f.registry.find(PROVIDER, "reviewer");
        assert.ok(reviewer);
        await f.session.setModel(reviewer);
        if (choice === "model-and-back") {
          const implementation = f.registry.find(PROVIDER, "builder");
          assert.ok(implementation);
          await f.session.setModel(implementation);
        }
      }
      if (choice === "tree") {
        // The target branch still records the handoff; only the live model shows it was superseded.
        assert.ok(handoffEntry);
        await f.session.navigateTree(handoffEntry);
        assert.ok(f.state()?.modelHandoff);
      }
      const after = f.current();
      await f.command("exit");
      if (choice === "thinking") {
        // The planning model still returns without owning the manual level.
        assert.deepEqual(f.current(), {
          model: "planner",
          thinking: "minimal",
        });
      } else {
        assert.equal(f.state()?.modelHandoff, undefined);
        assert.equal(f.current().model, choice === "model-and-back" ? "builder" : "reviewer");
        assert.deepEqual(f.current(), after);
        assert.ok(!f.notifications.some((entry) => entry.message.startsWith("Restored planning model")));
      }
    } finally {
      await f.close();
    }
  }
});

test("an unusable implementation model keeps the plan ready and the planning model active", async () => {
  for (const [implementationModel, reason] of [
    [`${PROVIDER}/missing`, /plan-model-faux\/missing is not in Pi's model registry\./],
    [`${LOCKED}/builder`, /plan-model-locked\/builder has no configured credentials\./],
  ] as const) {
    const f = await fixture({ implementationModel });
    try {
      await f.planReady();
      await f.command("implement");
      const warning = f.notifications.at(-1);
      assert.equal(warning?.level, "warning");
      assert.match(warning?.message ?? "", reason);
      assert.match(warning?.message ?? "", /Implementation was not started; the plan remains available\./);
      assert.deepEqual(f.sent, []);
      assert.deepEqual(f.current(), { model: "planner", thinking: "high" });
      assert.equal(f.state()?.enabled, true);
      assert.equal(f.state()?.latestPlan, "# Build it");
    } finally {
      await f.close();
    }
  }
});

test("setModel returning false rolls the handoff back to the ready plan", async () => {
  let refuse = true;
  const f = await fixture(configured, {
    setModel: (original) => async (model) => (refuse ? false : original(model)),
  });
  try {
    await f.planReady();
    await f.command("implement");
    assert.deepEqual(f.sent, []);
    assert.equal(f.notifications.at(-1)?.level, "warning");
    assert.match(
      f.notifications.at(-1)?.message ?? "",
      /^Unable to switch to the implementation model plan-model-faux\/builder has no configured credentials\. Implementation was not started/,
    );
    assert.deepEqual(f.current(), { model: "planner", thinking: "high" });
    const ready = f.state();
    assert.equal(ready?.enabled, true);
    assert.equal(ready?.latestPlan, "# Build it");
    assert.equal(ready?.activeImplementation, undefined);
    assert.equal(ready?.modelHandoff, undefined);

    refuse = false;
    await f.command("implement");
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.current(), { model: "builder", thinking: "low" });
  } finally {
    await f.close();
  }
});

const gatedSwitches = [
  ["apply", "earlier"],
  ["apply", "later"],
  ["restore", "earlier"],
  ["restore", "later"],
] as const;

for (const [phase, order] of gatedSwitches) {
  test(`${order}-loaded model_select gate: branch navigation invalidates ${phase} before thinking mutation or compensation`, async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let armed = false;
    const f = await fixture(
      { ...configured, thinkingLevel: "minimal" },
      {
        [order === "earlier" ? "beforePlan" : "afterPlan"]: (pi: ExtensionAPI) => {
          pi.on("model_select", async (event) => {
            if (!armed || event.source !== "set") return;
            armed = false;
            enter();
            await held;
          });
        },
      },
    );
    try {
      await f.command("start");
      const destination = f.manager.getLeafId();
      assert.ok(destination);
      const destinationState = JSON.stringify(f.state());
      await f.command("exit");
      await f.planReady();
      if (phase === "restore") await f.command("implement");
      const sent = f.sent.length;
      armed = true;
      const switching = f.command(phase === "apply" ? "implement" : "exit");
      await entered;
      await f.session.navigateTree(destination);
      assert.equal(f.current().thinking, "minimal");
      const target = f.current();
      release();
      await switching;
      assert.deepEqual(f.current(), target);
      assert.equal(JSON.stringify(f.state()), destinationState);
      assert.equal(f.state()?.modelHandoff, undefined);
      assert.equal(f.sent.length, sent);
    } finally {
      release();
      await f.close();
    }
  });
}

for (const [phase, order] of gatedSwitches) {
  const choices =
    order === "earlier"
      ? (["model", "model-and-back"] as const)
      : (["model", "model-and-back", "thinking", "thinking-and-back"] as const);
  for (const choice of choices) {
    test(`${order}-loaded model_select gate: manual ${choice} during pending ${phase} keeps selection ownership`, async () => {
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let armed = false;
      const f = await fixture(configured, {
        [order === "earlier" ? "beforePlan" : "afterPlan"]: (pi: ExtensionAPI) => {
          pi.on("model_select", async (event) => {
            if (!armed || event.source !== "set") return;
            armed = false;
            entered.resolve();
            await held.promise;
          });
        },
      });
      try {
        await f.planReady();
        if (phase === "restore") await f.command("implement");
        const sent = f.sent.length;
        armed = true;
        const pending = f.command(phase === "apply" ? "implement" : "exit");
        await entered.promise;
        if (choice.startsWith("model")) {
          const reviewer = f.registry.find(PROVIDER, "reviewer");
          assert.ok(reviewer);
          f.session.settingsManager.setModelThinkingLevel(PROVIDER, "reviewer", "low");
          await f.session.setModel(reviewer);
          if (choice === "model-and-back") {
            const target = f.registry.find(PROVIDER, phase === "apply" ? "builder" : "planner");
            assert.ok(target);
            await f.session.setModel(target);
          }
        } else {
          const original = f.session.thinkingLevel;
          f.session.setThinkingLevel("minimal");
          if (choice === "thinking-and-back") f.session.setThinkingLevel(original);
        }
        const manual = f.current();
        held.resolve();
        await pending;
        assert.deepEqual(f.current(), manual);
        assert.equal(f.state()?.modelHandoff, undefined);
        assert.equal(f.sent.length, sent, "obsolete apply must not send or persist a handoff");
      } finally {
        held.resolve();
        await f.close();
      }
    });
  }
}

for (const order of ["earlier", "later"] as const) {
  for (const phase of ["apply", "restore"] as const) {
    for (const change of ["manual", "automatic", "automatic-and-manual", "none"] as const) {
      test(`${order}-loaded model_select gate during ${phase}: ${change} thinking provenance`, async () => {
        const held = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        let armed = false;
        const gate = (pi: ExtensionAPI) => {
          pi.on("model_select", async (event) => {
            if (!armed || event.source !== "set") return;
            armed = false;
            entered.resolve();
            await held.promise;
          });
        };
        const f = await fixture(configured, order === "earlier" ? { beforePlan: gate } : { afterPlan: gate });
        try {
          await f.planReady();
          if (phase === "restore") await f.command("implement");
          const sent = f.sent.length;
          const notificationCount = f.notifications.length;
          const before = f.current().thinking;
          const target = phase === "apply" ? "builder" : "planner";
          const automatic = change.startsWith("automatic");
          f.session.settingsManager.setModelThinkingLevel(PROVIDER, target, automatic ? "medium" : before);
          armed = true;
          const pending = f.command(phase === "apply" ? "implement" : "exit");
          await entered.promise;
          assert.deepEqual(f.current(), { model: target, thinking: automatic ? "medium" : before });
          const manual = change === "manual" || change === "automatic-and-manual";
          if (manual) f.session.setThinkingLevel("minimal");
          held.resolve();
          await pending;

          const obsolete = manual && order === "later";
          const ambiguous = !obsolete && change !== "none";
          const expectedThinking = manual ? "minimal" : automatic ? "medium" : phase === "apply" ? "low" : "high";
          assert.deepEqual(f.current(), { model: target, thinking: expectedThinking });
          const warnings = f.notifications.slice(notificationCount).filter((entry) => entry.level === "warning");
          assert.equal(warnings.length, ambiguous ? 1 : 0);
          if (ambiguous)
            assert.match(warnings[0]?.message ?? "", /Skipped .*thinking.*ambiguous; kept the current level/);
          assert.equal(f.sent.length, sent + (phase === "apply" && !obsolete ? 1 : 0));
          if (phase === "apply" && !obsolete) {
            const expectedHandoff = {
              appliedModel: builder,
              previousModel: planner,
              ...(!ambiguous ? { previousThinkingLevel: "high", appliedThinkingLevel: "low" } : {}),
            };
            assert.deepEqual(f.state()?.modelHandoff, expectedHandoff);
            if (ambiguous) {
              await f.session.reload();
              assert.deepEqual(
                f.state()?.modelHandoff,
                expectedHandoff,
                "ambiguous thinking is never persisted as owned",
              );
              // A later unambiguous model-only restore must not force the old
              // planning level over the previously ambiguous current level.
              f.session.settingsManager.setModelThinkingLevel(PROVIDER, "planner", expectedThinking);
              await f.command("exit");
              assert.deepEqual(f.current(), { model: "planner", thinking: expectedThinking });
              assert.equal(f.state()?.modelHandoff, undefined);
            }
          } else {
            assert.equal(f.state()?.modelHandoff, undefined);
          }
        } finally {
          held.resolve();
          await f.close();
        }
      });
    }
  }
}

for (const phase of ["apply", "restore"] as const) {
  for (const change of ["automatic", "manual", "owned"] as const) {
    test(`earlier thinking_level_select gate during ${phase}: ${change} transition`, async () => {
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const modelHeld = Promise.withResolvers<void>();
      const modelEntered = Promise.withResolvers<void>();
      const expectedThinking =
        change === "automatic" ? "medium" : change === "manual" ? "minimal" : phase === "apply" ? "low" : "high";
      let armed = false;
      let gateModel = false;
      const f = await fixture(configured, {
        beforePlan: (pi) => {
          pi.on("model_select", async () => {
            if (!gateModel) return;
            gateModel = false;
            modelEntered.resolve();
            await modelHeld.promise;
          });
          pi.on("thinking_level_select", async () => {
            if (!armed) return;
            armed = false;
            entered.resolve();
            await held.promise;
          });
        },
        afterPlan: (pi) => {
          pi.on("thinking_level_select", (event) => {
            if (event.level === expectedThinking) completed.resolve();
          });
        },
      });
      try {
        await f.planReady();
        if (phase === "restore") await f.command("implement");
        const notificationCount = f.notifications.length;
        // Plan's thinking callback is held even after the command completes.
        // Native branch entries cannot lag, and only owned setter entries may
        // be excluded. For manual changes, also hold model observation.
        const target = phase === "apply" ? "builder" : "planner";
        f.session.settingsManager.setModelThinkingLevel(
          PROVIDER,
          target,
          change === "automatic" ? "medium" : f.current().thinking,
        );
        armed = true;
        gateModel = change === "manual";
        const pending = f.command(phase === "apply" ? "implement" : "exit");
        if (change === "manual") {
          await modelEntered.promise;
          f.session.setThinkingLevel("minimal");
          modelHeld.resolve();
        }
        await pending;
        await entered.promise;
        assert.deepEqual(f.current(), { model: target, thinking: expectedThinking });
        const expectedHandoff =
          phase === "apply"
            ? {
                appliedModel: builder,
                previousModel: planner,
                ...(change === "owned" ? { previousThinkingLevel: "high", appliedThinkingLevel: "low" } : {}),
              }
            : undefined;
        assert.deepEqual(f.state()?.modelHandoff, expectedHandoff);
        const warnings = f.notifications.slice(notificationCount).filter((entry) => entry.level === "warning");
        assert.equal(warnings.length, change === "owned" ? 0 : 1);
        if (change !== "owned") assert.match(warnings[0]?.message ?? "", /thinking.*ambiguous; kept the current level/);
        held.resolve();
        await completed.promise;
        assert.deepEqual(f.current(), { model: target, thinking: expectedThinking });
        assert.deepEqual(
          f.state()?.modelHandoff,
          expectedHandoff,
          "late observation must not change thinking ownership",
        );
      } finally {
        held.resolve();
        modelHeld.resolve();
        await f.close();
      }
    });
  }
}

test("a thinking-only handoff retires on a different manual model even with unchanged effective thinking, including reload", async () => {
  const f = await fixture({ implementationThinkingLevel: "low" });
  try {
    await f.planReady();
    await f.command("implement");
    assert.equal(f.current().thinking, "low");
    assert.ok(f.state()?.modelHandoff);
    const reviewer = f.registry.find(PROVIDER, "reviewer");
    assert.ok(reviewer);
    f.session.settingsManager.setModelThinkingLevel(PROVIDER, "reviewer", "low");
    await f.session.setModel(reviewer);
    assert.deepEqual(f.current(), { model: "reviewer", thinking: "low" });
    assert.equal(f.state()?.modelHandoff, undefined);
    await f.session.reload();
    assert.equal(f.state()?.modelHandoff, undefined);
    await f.command("exit");
    assert.deepEqual(f.current(), { model: "reviewer", thinking: "low" });
  } finally {
    await f.close();
  }
});

test("a resumed implementation stays on its model and /plan exit still restores the planning model", async () => {
  const first = await fixture(configured);
  let resumed: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await first.planReady();
    await first.command("implement");
    await first.runHandoff();
    const sessionFile = first.manager.getSessionFile();
    assert.ok(sessionFile);
    await first.close(true);

    resumed = await fixture(configured, { cwd: first.cwd, sessionFile });
    assert.deepEqual(resumed.current(), { model: "builder", thinking: "low" });
    assert.deepEqual(resumed.state()?.modelHandoff, {
      appliedModel: builder,
      previousModel: planner,
      previousThinkingLevel: "high",
      appliedThinkingLevel: "low",
    });
    await resumed.command("exit");
    assert.deepEqual(resumed.current(), { model: "planner", thinking: "high" });
  } finally {
    await resumed?.close(true);
    rmSync(first.cwd, { recursive: true, force: true });
  }
});

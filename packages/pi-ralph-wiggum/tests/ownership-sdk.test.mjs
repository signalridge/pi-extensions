import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import ralph from "../index.ts";

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(earlier = () => {}, retry = { enabled: false }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-sdk-"));
  const faux = fauxProvider({ provider: "ralph-faux", models: [{ id: "test", contextWindow: 200_000 }] });
  const runtime = await ModelRuntime.create({
    authPath: path.join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);
  const manager = SessionManager.inMemory(cwd);
  const root = manager.appendCustomEntry("root", {});
  manager.appendCustomEntry("work", {});
  const queued = [];
  let nativeSend;
  let api;
  let actualQueue = false;
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
        name: "ralph",
        factory: (pi) => {
          ralph(pi);
          api = pi;
          nativeSend = pi.sendUserMessage.bind(pi);
          pi.sendUserMessage = (message, options) => {
            queued.push(message);
            if (actualQueue) nativeSend(message, options);
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
    model: registry.find("ralph-faux", "test"),
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry,
      images: { autoResize: false },
    }),
  });
  await session.bindExtensions({});
  const command = (text) =>
    session.extensionRunner.getCommand("ralph").handler(text, session.extensionRunner.createCommandContext());
  const state = () => JSON.parse(fs.readFileSync(path.join(cwd, ".ralph", "owned.state.json"), "utf8"));
  return {
    session,
    manager,
    root,
    cwd,
    command,
    faux,
    queued,
    state,
    api,
    realQueue() {
      actualQueue = true;
    },
    async close() {
      await session.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}
function response(text) {
  return fauxAssistantMessage(text);
}

test("paused one-use deliveries are rejected before provider work", async () => {
  const f = await fixture();
  try {
    await f.command("start owned");
    const token = f.queued[0];
    await f.command("stop");
    let requests = 0;
    f.faux.setResponses([
      () => {
        requests++;
        return response("should not run");
      },
    ]);
    await f.session.prompt(token, { source: "extension" });
    assert.equal(requests, 0);
    assert.equal(f.state().status, "paused");
    const images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
    f.faux.setResponses([
      () => {
        requests++;
        return response("Discussing the literal token");
      },
    ]);
    await f.session.prompt(token, { source: "rpc", images });
    assert.equal(requests, 1);
    assert.deepEqual(f.session.messages.filter((message) => message.role === "user").at(-1).content, [
      { type: "text", text: token },
      ...images,
    ]);
    assert.equal(f.state().status, "paused");
  } finally {
    await f.close();
  }
});

test("pausing a delivered iteration blocks late substantive tools before execution", async () => {
  const f = await fixture();
  const entered = gate();
  const release = gate();
  let tools = 0;
  let requests = 0;
  try {
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
    await f.command("start owned");
    f.faux.setResponses([
      async () => {
        requests++;
        entered.release();
        await release.promise;
        return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
      },
      () => {
        requests++;
        return response("must not request this");
      },
    ]);
    const prompt = f.session.prompt(f.queued[0], { source: "extension" });
    await entered.promise;
    await f.command("stop");
    release.release();
    await prompt;
    assert.equal(tools, 0);
    assert.equal(requests, 1);
    assert.equal(f.state().status, "paused");
  } finally {
    release.release();
    await f.close();
  }
});

for (const deletion of ["cancel owned", "nuke --yes"]) {
  test(`${deletion} retires an in-flight owned model before its late tool`, async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    let tools = 0;
    try {
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
      await f.command("start owned");
      f.faux.setResponses([
        async () => {
          entered.release();
          await release.promise;
          return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
        },
        response("done"),
      ]);
      const prompt = f.session.prompt(f.queued[0], { source: "extension" });
      await entered.promise;
      await f.command(deletion);
      release.release();
      await prompt;
      assert.equal(tools, 0);
    } finally {
      release.release();
      await f.close();
    }
  });
}

test("owned context, standalone completion, extension wakes and exact user literals", async () => {
  const f = await fixture();
  try {
    await f.command("start owned");
    const marker = "<promise>COMPLETE</promise>";
    const contexts = [];
    f.faux.setResponses([
      (ctx) => {
        contexts.push(ctx);
        return response(`Quoted: ${marker}\n\n\`\`\`\n${marker}\n\`\`\``);
      },
      (ctx) => {
        contexts.push(ctx);
        return fauxAssistantMessage(fauxToolCall("ralph_done", {}), { stopReason: "toolUse" });
      },
      (ctx) => {
        contexts.push(ctx);
        return response(marker);
      },
      (ctx) => {
        contexts.push(ctx);
        return response(marker);
      },
    ]);
    await f.session.prompt(f.queued[0], { source: "extension" });
    assert.match(JSON.stringify(contexts[0]), /RALPH LOOP - owned/);
    assert.equal(f.state().status, "active");
    await f.session.prompt("A background command exited.", { source: "extension" });
    assert.doesNotMatch(JSON.stringify(contexts[1]), /RALPH LOOP - owned/);
    assert.equal(f.state().iteration, 1);
    assert.equal(f.state().status, "active");
    const text = "Explain <!-- pi-ralph-iteration:example --> verbatim";
    const images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
    await f.session.prompt(text, { source: "rpc", images });
    const native = f.session.messages.filter((message) => message.role === "user").at(-1);
    assert.deepEqual(native.content, [{ type: "text", text }, ...images]);
    assert.match(JSON.stringify(contexts[3]), /RALPH LOOP - owned/);
    assert.equal(f.state().status, "completed");
  } finally {
    await f.close();
  }
});

test("pause after ralph_done retires both the finished run and its queued nonce", async () => {
  const f = await fixture();
  let requests = 0;
  try {
    await f.command("start owned");
    f.api.on("tool_execution_end", async (event) => {
      if (event.toolName === "ralph_done") await f.command("stop");
    });
    f.faux.setResponses([
      () => {
        requests++;
        return fauxAssistantMessage(fauxToolCall("ralph_done", {}), { stopReason: "toolUse" });
      },
      () => {
        requests++;
        return response("must not request this");
      },
    ]);
    await f.session.prompt(f.queued[0], { source: "extension" });
    assert.equal(requests, 1);
    assert.equal(f.state().status, "paused");
    assert.equal(f.state().iteration, 2);
    await f.session.prompt(f.queued[1], { source: "extension" });
    assert.equal(requests, 1);
    assert.equal(f.state().iteration, 2);
  } finally {
    await f.close();
  }
});

test("a follow-up iteration continuing without before_agent_start gets its own nonce", async () => {
  const f = await fixture();
  try {
    await f.command("start owned --max-iterations 5");
    f.realQueue();
    const contexts = [];
    f.faux.setResponses([
      (ctx) => {
        contexts.push(ctx);
        return fauxAssistantMessage(fauxToolCall("ralph_done", {}), { stopReason: "toolUse" });
      },
      (ctx) => {
        contexts.push(ctx);
        return response("Iteration delivered");
      },
      (ctx) => {
        contexts.push(ctx);
        return response("Iteration delivered");
      },
    ]);
    await f.session.prompt(f.queued[0], { source: "extension" });
    assert.equal(f.state().iteration, 2);
    assert.notEqual(f.queued[0], f.queued[1]);
    assert.ok(contexts.some((ctx) => /RALPH LOOP - owned - Iteration 2/.test(JSON.stringify(ctx))));
    const count = contexts.length;
    f.faux.setResponses([
      () => {
        throw new Error("replayed nonce requested a provider");
      },
    ]);
    await f.session.prompt(f.queued[1], { source: "extension" });
    assert.equal(contexts.length, count);
  } finally {
    await f.close();
  }
});

test("live committed branch divergence rejects input before a late session_tree handler", async () => {
  const inputEntered = gate();
  const releaseInput = gate();
  const treeEntered = gate();
  const releaseTree = gate();
  const f = await fixture((pi) => {
    pi.on("input", async (event) => {
      if (event.source === "extension") {
        inputEntered.release();
        await releaseInput.promise;
      }
    });
    pi.on("session_tree", async () => {
      treeEntered.release();
      await releaseTree.promise;
    });
  });
  try {
    await f.command("start owned");
    let requests = 0;
    f.faux.setResponses([
      () => {
        requests++;
        return response("stale");
      },
    ]);
    const prompt = f.session.prompt(f.queued[0], { source: "extension" });
    await inputEntered.promise;
    const navigation = f.session.navigateTree(f.root);
    await treeEntered.promise;
    assert.equal(f.manager.getLeafId(), f.root);
    releaseInput.release();
    await prompt;
    assert.equal(requests, 0);
    assert.equal(f.state().iteration, 1);
    releaseTree.release();
    await navigation;
    f.faux.setResponses([response("ordinary")]);
    await f.session.prompt("Continue", { source: "rpc" });
    assert.equal(f.state().iteration, 1);
  } finally {
    releaseInput.release();
    releaseTree.release();
    await f.close();
  }
});

test("a public SessionManager rewind rejects a native context before late tree dispatch", async () => {
  const contextEntered = gate();
  const releaseContext = gate();
  const treeEntered = gate();
  const releaseTree = gate();
  let gated = false;
  const f = await fixture((pi) => {
    pi.on("context", async () => {
      if (!gated) {
        gated = true;
        contextEntered.release();
        await releaseContext.promise;
      }
    });
    pi.on("session_tree", async () => {
      treeEntered.release();
      await releaseTree.promise;
    });
  });
  try {
    const inputLeaf = f.manager.getLeafId();
    await f.command("start owned");
    let requests = 0;
    f.faux.setResponses([
      () => {
        requests++;
        return response("stale");
      },
    ]);
    const prompt = f.session.prompt(f.queued[0], { source: "extension" });
    await contextEntered.promise;
    // navigateTree itself refuses busy runs in this SDK. Exercise the public
    // committed manager + sequential event boundary without bypassing providers.
    f.manager.branch(inputLeaf);
    const navigation = f.session.extensionRunner.emit({ type: "session_tree", newLeafId: inputLeaf });
    await treeEntered.promise;
    releaseContext.release();
    await prompt;
    assert.equal(requests, 0);
    assert.equal(f.state().iteration, 1);
    releaseTree.release();
    await navigation;
  } finally {
    releaseContext.release();
    releaseTree.release();
    await f.close();
  }
});

for (const streamingBehavior of ["followUp", "steer"]) {
  test(`real queued ${streamingBehavior} continuation is owned under the current loop`, async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    try {
      await f.command("start owned --max-iterations 5");
      f.faux.setResponses([
        async () => {
          entered.release();
          await release.promise;
          return response("Working");
        },
        response("<promise>COMPLETE</promise>"),
      ]);
      const prompt = f.session.prompt(f.queued[0], { source: "extension" });
      await entered.promise;
      await f.session.prompt("Continue the owned work", { source: "rpc", streamingBehavior });
      release.release();
      await prompt;
      assert.equal(f.state().status, "completed");
      assert.equal(f.state().iteration, 1);
    } finally {
      release.release();
      await f.close();
    }
  });
}

for (const real of [false, true])
  for (const order of ["A-first", "B-first"]) {
    for (const lanes of [
      ["steer", "steer"],
      ["followUp", "followUp"],
      ["steer", "followUp"],
      ["followUp", "steer"],
    ]) {
      test(`unique ${real ? "real" : "owned"} iteration survives unrelated queued content: ${order} ${lanes.join("/")}`, async () => {
        const f = await fixture();
        const entered = gate();
        const release = gate();
        try {
          await f.command("start owned --max-iterations 5");
          f.session.setSteeringMode("one-at-a-time");
          f.session.setFollowUpMode("one-at-a-time");
          const token = f.queued[0];
          const A = real ? "A: actual user continuation" : token;
          const contexts = [];
          const respond = (ctx) => {
            contexts.push(ctx);
            return response("working");
          };
          f.faux.setResponses([
            async () => {
              entered.release();
              await release.promise;
              return response("holding");
            },
            respond,
            respond,
            respond,
          ]);
          const running = f.session.prompt("Hold an unrelated background run", { source: "extension" });
          await entered.promise;
          const queueA = () => f.session.prompt(A, { source: real ? "rpc" : "extension", streamingBehavior: lanes[0] });
          const queueB = () =>
            f.session.prompt("B: unrelated notification", {
              source: "extension",
              streamingBehavior: lanes[1],
              images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
            });
          if (order === "A-first") {
            await queueA();
            await queueB();
          } else {
            await queueB();
            await queueA();
          }
          release.release();
          await running;
          assert.ok(
            contexts.some((ctx) => /RALPH LOOP - owned/.test(JSON.stringify(ctx))),
            "the unique owned lane gets loop context",
          );
          for (const ctx of contexts) {
            const latest = ctx.messages.filter((message) => message.role === "user").at(-1);
            if (JSON.stringify(latest?.content).includes("B: unrelated notification"))
              assert.doesNotMatch(JSON.stringify(ctx), /RALPH LOOP - owned/);
          }
          if (!real) {
            let replays = 0;
            f.faux.setResponses([
              () => {
                replays++;
                return response("replay");
              },
            ]);
            await f.session.prompt(token, { source: "extension" });
            assert.equal(replays, 0, "the nonce was consumed at acceptance");
          }
        } finally {
          release.release();
          await f.close();
        }
      });
    }
  }

for (const realFirst of [false, true]) {
  test(`same-content queued sources cannot acquire loop authority: realFirst=${realFirst}`, async () => {
    const f = await fixture();
    const entered = gate();
    const release = gate();
    const contexts = [];
    try {
      await f.command("start owned --max-iterations 5");
      f.faux.setResponses([
        async () => {
          entered.release();
          await release.promise;
          return response("holding");
        },
        (ctx) => {
          contexts.push(ctx);
          return response("<promise>COMPLETE</promise>");
        },
        (ctx) => {
          contexts.push(ctx);
          return response("<promise>COMPLETE</promise>");
        },
      ]);
      const running = f.session.prompt("Hold a background run", { source: "extension" });
      await entered.promise;
      const sources = realFirst ? ["rpc", "extension"] : ["extension", "rpc"];
      for (const [index, source] of sources.entries())
        await f.session.prompt("identical content", { source, streamingBehavior: index ? "followUp" : "steer" });
      release.release();
      await running;
      assert.equal(f.state().status, "active");
      assert.equal(f.state().iteration, 1);
      for (const ctx of contexts) assert.doesNotMatch(JSON.stringify(ctx), /RALPH LOOP - owned/);
    } finally {
      release.release();
      await f.close();
    }
  });
}

for (const deletion of ["cancel owned", "nuke --yes"]) {
  for (const source of ["owned", "extension", "rpc"]) {
    const owned = source === "owned";
    test(`${deletion} during a later tool_call barrier aborts only an accepted Ralph run: ${source}`, async () => {
      const f = await fixture();
      const entered = gate();
      const held = gate();
      let tools = 0;
      let aborts = 0;
      let toolSignal;
      try {
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
        // Ralph's tool hook has already allowed the call when this later handler waits.
        f.api.on("tool_call", async (event, ctx) => {
          if (event.toolName === "probe") {
            toolSignal = ctx.signal;
            toolSignal.addEventListener(
              "abort",
              () => {
                aborts++;
              },
              { once: true },
            );
            entered.release();
            await held.promise;
          }
        });
        await f.command("start owned");
        f.faux.setResponses([
          fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
          response("ordinary"),
        ]);
        const prompt = f.session.prompt(owned ? f.queued[0] : "Unrelated manual turn or background wake", {
          source: owned ? "extension" : source,
        });
        await entered.promise;
        await f.command(deletion);
        assert.equal(toolSignal.aborted, owned);
        held.release();
        await prompt;
        assert.equal(tools, owned ? 0 : 1);
        assert.equal(aborts, owned ? 1 : 0);
        if (owned) {
          f.faux.setResponses([
            fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
            response("new root"),
          ]);
          await f.session.prompt("Fresh unrelated manual turn", { source: "rpc" });
          assert.equal(tools, 1);
          assert.equal(toolSignal.aborted, false);
          assert.equal(aborts, 1);
        }
      } finally {
        held.release();
        await f.close();
      }
    });
  }
}

for (const deletion of ["cancel owned", "nuke --yes"]) {
  test(`${deletion} still owns abort after ralph_done consumes iteration authority in the same native run`, async () => {
    const f = await fixture();
    const entered = gate();
    const held = gate();
    const consumed = gate();
    let tools = 0;
    try {
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
      f.api.on("tool_call", async (event) => {
        if (event.toolName === "probe") {
          entered.release();
          await held.promise;
        }
      });
      f.api.on("tool_execution_end", (event) => {
        if (event.toolName === "ralph_done") consumed.release();
      });
      await f.command("start owned");
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ralph_done", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
        response("ordinary"),
      ]);
      const running = f.session.prompt(f.queued[0], { source: "extension" });
      await Promise.race([
        Promise.all([entered.promise, consumed.promise]),
        running.then(() => {
          throw new Error("native run did not enter both tool barriers");
        }),
      ]);
      assert.equal(f.state().iteration, 2);
      await f.command(deletion);
      held.release();
      await running;
      assert.equal(tools, 0);
    } finally {
      held.release();
      await f.close();
    }
  });
}

for (const stopFirst of [false, true]) {
  test(`resume during a later tool hook preserves the accepted run until ${stopFirst ? "stopped" : "settled"}`, async () => {
    const f = await fixture();
    const entered = gate();
    const held = gate();
    let tools = 0;
    let toolSignal;
    try {
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
      f.api.on("tool_call", async (event, ctx) => {
        if (event.toolName === "probe") {
          toolSignal = ctx.signal;
          entered.release();
          await held.promise;
        }
      });
      await f.command("start owned");
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
        response("ordinary"),
      ]);
      const running = f.session.prompt(f.queued[0], { source: "extension" });
      await entered.promise;
      const stateFile = path.join(f.cwd, ".ralph", "owned.state.json");
      const before = fs.readFileSync(stateFile);
      await f.command("resume owned");
      assert.deepEqual(fs.readFileSync(stateFile), before);
      assert.equal(f.state().iteration, 1);
      assert.equal(f.queued.length, 1);
      assert.equal(toolSignal.aborted, false);
      // Invalid starts also cannot steal the accepted operation's abort authority.
      await f.command("start other --max-iterations 0.5");
      const start = f.session.extensionRunner.getToolDefinition("ralph_start");
      await assert.rejects(
        start.execute(
          "invalid",
          { name: "other", taskContent: "overwrite", reflectEvery: -1 },
          undefined,
          undefined,
          f.session.extensionRunner.createCommandContext(),
        ),
        /reflectEvery.*nonnegative safe integer/,
      );
      assert.deepEqual(fs.readFileSync(stateFile), before);
      assert.equal(fs.existsSync(path.join(f.cwd, ".ralph", "other.md")), false);
      assert.equal(f.queued.length, 1);
      // Valid starts must not replace the accepted operation either.
      await f.command("start other");
      await start.execute(
        "valid-second",
        { name: "other", taskContent: "A valid task" },
        undefined,
        undefined,
        f.session.extensionRunner.createCommandContext(),
      );
      assert.deepEqual(fs.readFileSync(stateFile), before);
      assert.equal(fs.existsSync(path.join(f.cwd, ".ralph", "other.md")), false);
      assert.equal(f.queued.length, 1);
      assert.equal(toolSignal.aborted, false);
      if (stopFirst) {
        await f.command("stop");
        assert.equal(toolSignal.aborted, true, "resume rejection preserves cancellation capability");
      }
      held.release();
      await running;
      assert.equal(tools, stopFirst ? 0 : 1);
      assert.equal(f.state().status, stopFirst ? "paused" : "active");
      await f.command("resume owned");
      assert.equal(f.state().iteration, 2);
      assert.equal(f.state().status, "active");
      assert.equal(f.queued.length, 2);
      f.faux.setResponses([response("resumed")]);
      await f.session.prompt(f.queued[1], { source: "extension" });
      assert.equal(f.state().iteration, 2);
    } finally {
      held.release();
      await f.close();
    }
  });
}

for (const finalReason of ["stop", "error", "aborted"]) {
  test(`before-settle continuation retains N=1 ownership through final ${finalReason}`, async () => {
    const f = await fixture();
    try {
      await f.command("start owned --max-iterations 1");
      let boundaries = 0;
      let requests = 0;
      const banners = () =>
        f.manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "ralph-status");
      f.api.on("agent_before_settle", (event) => {
        assert.equal(f.state().status, "active", "agent_end must not finalize the owned iteration");
        if (boundaries++ === 0)
          return {
            entries: [
              ...event.entries,
              { type: "custom_message", customType: "review", content: "Verify once more.", display: false },
            ],
            continue: true,
          };
      });
      f.faux.setResponses([
        () => {
          requests++;
          return response("<promise>COMPLETE</promise>");
        },
        () => {
          requests++;
          assert.equal(f.state().status, "active");
          return fauxAssistantMessage("Final outcome", {
            stopReason: finalReason,
            errorMessage: finalReason === "error" ? "nonretryable" : undefined,
          });
        },
        () => {
          throw new Error("a banner must not trigger a billed turn");
        },
      ]);
      await f.session.prompt(f.queued[0], { source: "extension" });
      assert.equal(requests, 2);
      assert.equal(f.state().status, finalReason === "stop" ? "completed" : "active");
      assert.equal(f.state().iteration, 1);
      assert.equal(f.queued.length, 1, "no terminal user follow-up");
      assert.equal(banners().length, finalReason === "stop" ? 1 : 0);
    } finally {
      await f.close();
    }
  });
}

test("abort during before-settle invalidates an earlier successful completion candidate", async () => {
  const f = await fixture();
  const entered = gate();
  const release = gate();
  try {
    await f.command("start owned --max-iterations 1");
    f.api.on("agent_before_settle", async () => {
      assert.equal(f.state().status, "active");
      entered.release();
      await release.promise;
    });
    f.faux.setResponses([response("<promise>COMPLETE</promise>")]);
    const running = f.session.prompt(f.queued[0], { source: "extension" });
    await entered.promise;
    const aborting = f.session.abort();
    release.release();
    await Promise.all([running, aborting]);
    assert.equal(f.state().status, "active");
    assert.equal(f.queued.length, 1);
    assert.equal(
      f.manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "ralph-status"),
      false,
    );
  } finally {
    release.release();
    await f.close();
  }
});

test("automatic SDK retry preserves executing identity and finalizes only after retry settlement", async () => {
  const f = await fixture(() => {}, { enabled: true, maxRetries: 1, baseDelayMs: 1 });
  try {
    await f.command("start owned --max-iterations 1");
    let requests = 0;
    const contexts = [];
    f.faux.setResponses([
      (ctx) => {
        requests++;
        contexts.push(ctx);
        return fauxAssistantMessage("<promise>COMPLETE</promise>", {
          stopReason: "error",
          errorMessage: "429 rate limit exceeded",
        });
      },
      (ctx) => {
        requests++;
        contexts.push(ctx);
        assert.equal(f.state().status, "active");
        return response("Retried successfully");
      },
      () => {
        throw new Error("unexpected banner-triggered request");
      },
    ]);
    await f.session.prompt(f.queued[0], { source: "extension" });
    assert.equal(requests, 2, "automatic retry must actually run");
    assert.equal(f.state().status, "completed");
    assert.equal(f.state().iteration, 1);
    assert.equal(f.queued.length, 1);
    for (const ctx of contexts) assert.match(JSON.stringify(ctx), /RALPH LOOP - owned - Iteration 1\/1/);
  } finally {
    await f.close();
  }
});

test("handled overlapping and transformed real inputs never acquire completion ownership", async () => {
  const f = await fixture();
  f.api.on("input", (event) => {
    if (event.source === "rpc" && event.text === "handled") return { action: "handled" };
    if (event.text === "transform") return { action: "transform", text: "different native text" };
  });
  try {
    await f.command("start owned");
    f.faux.setResponses([
      response("ordinary"),
      response("<promise>COMPLETE</promise>"),
      response("<promise>COMPLETE</promise>"),
    ]);
    await f.session.prompt(f.queued[0], { source: "extension" });
    await f.session.prompt("handled", { source: "rpc" });
    await f.session.prompt("handled", { source: "extension" });
    assert.equal(f.state().status, "active");
    await f.session.prompt("transform", { source: "rpc" });
    assert.equal(f.state().status, "active");
  } finally {
    await f.close();
  }
});

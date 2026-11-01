import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import recap from "../index.ts";

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const stage of ["auth", "response"]) {
  for (const navigation of ["sibling", "append", "cancelled"]) {
    test(`SDK ${navigation} validates recap ${stage} independently of delayed tree delivery`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "recap-live-origin-"));
      const entered = gate();
      const releaseWork = gate();
      const treeEntered = gate();
      const releaseTree = gate();
      let session;
      let calls = 0;
      let ownTree = false;
      let reads = 0;
      const widgets = [];
      const model = {
        provider: "origin-test",
        id: "side",
        api: `recap-live-${stage}-${navigation}`,
        baseUrl: "https://localhost.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      };
      registerApiProvider({
        api: model.api,
        stream() {
          throw new Error("wrong route");
        },
        streamSimple: () => {
          calls++;
          return {
            result: async () => {
              if (stage === "response") {
                entered.resolve();
                await releaseWork.promise;
              }
              return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Stale recap" }] };
            },
          };
        },
      });
      try {
        const settingsManager = SettingsManager.inMemory();
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir: cwd,
          settingsManager,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [
            {
              name: "two-gate-recap",
              factory: (pi) => {
                if (navigation === "cancelled") pi.on("session_before_tree", () => ({ cancel: true }));
                pi.on("session_tree", async () => {
                  treeEntered.resolve();
                  await releaseTree.promise;
                });
                recap(
                  new Proxy(pi, {
                    get(target, key) {
                      if (key === "getFlag")
                        return (name) =>
                          name === "recap-allow-raw-history"
                            ? true
                            : name === "recap-model"
                              ? "origin-test/side"
                              : name === "recap-disable-focus"
                                ? true
                                : target.getFlag(name);
                      return Reflect.get(target, key);
                    },
                  }),
                );
                pi.on("session_tree", () => {
                  ownTree = true;
                });
              },
            },
          ],
        });
        await loader.reload();
        const manager = SessionManager.inMemory(cwd);
        const root = manager.appendMessage({ role: "user", content: "same projected task", timestamp: 1 });
        const origin = manager.appendCustomEntry("origin metadata");
        const originMessages = manager.buildSessionProjection().messages;
        manager.branch(root);
        const destination = manager.appendCustomEntry("destination metadata");
        assert.deepEqual(manager.buildSessionProjection().messages, originMessages);
        manager.branch(origin);
        ({ session } = await createAgentSession({
          cwd,
          agentDir: cwd,
          model,
          settingsManager,
          resourceLoader: loader,
          sessionManager: manager,
          noTools: "all",
        }));
        await session.bindExtensions({
          mode: "rpc",
          uiContext: {
            setStatus() {},
            setWidget(_key, content) {
              if (Array.isArray(content)) widgets.push(content);
            },
          },
        });
        const ctx = session.extensionRunner.createCommandContext();
        ctx.modelRegistry.find = (provider, id) =>
          provider === model.provider && id === model.id ? { ...model } : undefined;
        ctx.modelRegistry.getApiKeyAndHeaders = async () => {
          if (stage === "auth") {
            entered.resolve();
            await releaseWork.promise;
          }
          return { ok: true, apiKey: "test" };
        };
        const projection = manager.buildSessionProjection.bind(manager);
        manager.buildSessionProjection = () => {
          reads++;
          return projection();
        };
        const openingLeaf = manager.getLeafId();
        const pending = session.extensionRunner.getCommand("recap").handler("", ctx);
        await entered.promise;
        let tree;
        if (navigation === "sibling") {
          tree = session.navigateTree(destination);
          await treeEntered.promise;
          assert.equal(manager.getLeafId(), destination);
        } else if (navigation === "cancelled") {
          assert.equal((await session.navigateTree(destination)).cancelled, true);
          assert.equal(manager.getLeafId(), openingLeaf);
        } else {
          manager.appendCustomEntry("ordinary appended metadata");
        }
        assert.equal(ownTree, false);
        const before = reads;
        releaseWork.resolve();
        await pending;
        assert.equal(ownTree, false);
        if (navigation === "sibling") {
          assert.equal(reads, before, "stale continuations cannot reproject destination history");
          assert.equal(calls, stage === "response" ? 1 : 0);
          assert.deepEqual(widgets, []);
        } else {
          assert.ok(reads > before, "unchanged projection on a valid prefix may finish");
          assert.equal(calls, 1);
          assert.deepEqual(widgets, [["✦ recap", "Stale recap"]]);
        }
        releaseTree.resolve();
        await tree;
      } finally {
        releaseWork.resolve();
        releaseTree.resolve();
        session?.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }
}

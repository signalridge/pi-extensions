import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import sessionRecap from "../index.ts";

for (const provider of ["opencode", "opencode-go"]) {
  test(`${provider} recap attributes the owning session on an isolated loopback wire`, async () => {
    const requests = [];
    // No provider authentication or external network: this server accepts a fake
    // credential solely because the OpenAI-compatible client requires one.
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()), url: request.url });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "loopback",
          object: "chat.completion.chunk",
          created: 1,
          model: "recap-test",
          choices: [{ index: 0, delta: { role: "assistant", content: "Loopback recap." }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const commands = new Map();
      const flags = new Map();
      sessionRecap({
        on() {},
        registerCommand: (name, command) => commands.set(name, command),
        registerFlag: (name, options) => flags.set(name, options.default),
        getFlag: (name) => flags.get(name),
      });
      flags.set("recap-allow-raw-history", true);
      flags.set("recap-model", `${provider}/recap-test`);
      const model = {
        id: "recap-test",
        name: "Loopback only",
        provider,
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4096,
      };
      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: "user", content: "Verify the isolated recap wire.", timestamp: 1 });
      const widgets = [];
      const notices = [];
      await commands.get("recap").handler("", {
        mode: "rpc",
        hasUI: true,
        model,
        sessionManager: manager,
        modelRegistry: {
          find: (p, id) => (p === provider && id === model.id ? model : undefined),
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: "loopback-fake-key",
            headers: { "x-test-profile": "consented-profile" },
            env: {},
            baseUrl: model.baseUrl,
          }),
        },
        ui: {
          setStatus() {},
          setWidget: (_key, value) => {
            if (Array.isArray(value)) widgets.push(value);
          },
          notify: (message) => notices.push(message),
        },
      });
      assert.deepEqual(notices, []);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "/v1/chat/completions");
      assert.equal(requests[0].headers["x-opencode-session"], manager.getSessionId());
      assert.equal(requests[0].headers["x-test-profile"], "consented-profile");
      assert.match(JSON.stringify(requests[0].body), /Verify the isolated recap wire/);
      assert.deepEqual(widgets, [["✦ recap", "Loopback recap."]]);
      assert.equal(manager.getBranch().length, 1, "recaps must remain temporary, not persisted history");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

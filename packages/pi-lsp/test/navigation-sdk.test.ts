import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import lsp from "../src/pi-lsp.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/diagnostics-server.mjs");
const MAIN = 'package main\n\nfunc greet(name string) string { return name }\n\nfunc main() { greet("x") }\n';
const OTHER = "package main\n\nvar _ = greet\n";

test("the real Pi SDK routes model tool calls through navigation, schema validation and an applied rename", async () => {
  assert.equal(VERSION, "1.5.0");
  const root = mkdtempSync(path.join(tmpdir(), "pi-lsp-sdk-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(path.join(cwd, "main.go"), MAIN);
  writeFileSync(path.join(cwd, "other.go"), OTHER);
  // A navigation-only server from user configuration, as a TS/JS setup would add one.
  writeFileSync(
    path.join(agentDir, "pi-lsp.json"),
    JSON.stringify({
      timeout: 10_000,
      servers: {
        navigator: {
          command: [process.execPath, fixture, "navigation"],
          extensions: [".go"],
          operations: ["definition", "references", "hover", "symbols", "rename"],
        },
      },
    }),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: AgentSession | undefined;
  try {
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const faux = fauxProvider({
      provider: "lsp-test",
      models: [{ id: "fixture" }],
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [{ name: "pi-lsp", factory: lsp }],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    session = (
      await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        model: faux.getModel(),
        thinkingLevel: "off",
        settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
        resourceLoader,
        tools: ["lsp_references", "lsp_hover", "lsp_rename"],
      })
    ).session;
    const errors: string[] = [];
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error.message),
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("lsp_references", {
          path: "other.go",
          line: 3,
          symbol: "greet",
        }),
        {
          stopReason: "toolUse",
        },
      ),
      // Pi validates arguments against the schema before the tool runs.
      fauxAssistantMessage(
        fauxToolCall("lsp_hover", {
          path: "main.go",
          line: 0,
          symbol: "greet",
        }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage(
        fauxToolCall("lsp_rename", {
          path: "main.go",
          line: 3,
          symbol: "greet",
          newName: "welcome",
          apply: true,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Renamed."),
    ]);
    await session.prompt("Rename greet to welcome.");

    const results = session.messages.flatMap((message) => (message.role === "toolResult" ? [message] : []));
    assert.deepEqual(
      results.map(({ toolName, isError }) => [toolName, isError]),
      [
        ["lsp_references", false],
        ["lsp_hover", true],
        ["lsp_rename", false],
      ],
    );
    const textOf = (index: number) =>
      results[index]?.content.map((item) => (item.type === "text" ? item.text : "")).join("") ?? "";
    assert.equal(
      textOf(0),
      [
        "navigator references for other.go:3:9 (greet): 3 location(s).",
        "",
        "main.go:3:6: func greet(name string) string { return name }",
        'main.go:5:15: func main() { greet("x") }',
        "other.go:3:9: var _ = greet",
      ].join("\n"),
    );
    assert.match(textOf(1), /^Validation failed for tool "lsp_hover":\n {2}- line: expected >= 1\n/);
    assert.match(
      textOf(2),
      /^navigator renamed main.go:3:6 \(greet\) to "welcome": applied 3 edit\(s\) in 2 file\(s\)\./,
    );
    assert.equal(readFileSync(path.join(cwd, "main.go"), "utf8"), MAIN.replaceAll("greet", "welcome"));
    assert.equal(readFileSync(path.join(cwd, "other.go"), "utf8"), OTHER.replaceAll("greet", "welcome"));
    assert.deepEqual(errors, []);
  } finally {
    if (session) {
      await session.abort();
      session.dispose();
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

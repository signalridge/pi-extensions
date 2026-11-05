import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { REMINDER_MESSAGE } from "../src/extension.js";
import rules from "../src/index.js";
import { DELIVERY_ENTRY, readLedger } from "../src/ledger.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A real Pi 1.5 session with this extension, a faux provider and rule files under `project/` and `agent/`. */
async function fixture(
  files: Record<string, string>,
  options: { trusted?: boolean; probe?: (pi: ExtensionAPI) => void } = {},
) {
  expect(VERSION).toBe("1.5.0");
  const root = mkdtempSync(join(tmpdir(), "pi-rules-sdk-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const faux = fauxProvider({
    provider: "rules-test",
    models: [{ id: "fixture" }],
  });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = new ModelRegistry(runtime).find("rules-test", "fixture");
  if (!model) throw new Error("Missing test model");
  const settingsManager = SettingsManager.inMemory(
    { compaction: { enabled: false }, retry: { enabled: false } },
    { projectTrusted: options.trusted ?? true },
  );
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [rules, ...(options.probe ? [options.probe] : [])],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: ["read", "write", "edit", "bash", "read_rule"],
  });
  const errors: string[] = [];
  await session.bindExtensions({
    mode: "json",
    onError: (error) => errors.push(error.message),
  });
  cleanup.push(async () => {
    await session.abort();
    session.dispose();
  });
  // Every request the model receives, so tests can assert on what it actually saw.
  const seen: TranscriptContext[] = [];
  const respond =
    (message: AssistantMessage) =>
    (context: TranscriptContext): AssistantMessage => {
      seen.push(structuredClone(context));
      return message;
    };
  const tool = (name: string, args: Record<string, unknown>) =>
    respond(fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }));
  const text = (value: string) => respond(fauxAssistantMessage(value));
  return { session, faux, cwd, errors, seen, respond, tool, text };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const systemMessages = (context: TranscriptContext) => context.messages.filter((message) => message.role === "system");
const deliveries = (f: Fixture) =>
  f.session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === DELIVERY_ENTRY);
/** Count `needle` in a request as serialized JSON, where its quotes are escaped. */
const occurrences = (context: TranscriptContext | undefined, needle: string) =>
  JSON.stringify(context ?? null).split(JSON.stringify(needle).slice(1, -1)).length - 1;
function toolResults(f: Fixture, toolName: string) {
  return f.session.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === toolName ? [message] : [],
  );
}
const resultText = (message: ReturnType<typeof toolResults>[number]) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

describe("real Pi 1.4 SDK session", () => {
  it("injects always rules and the index as one stable section, and read_rule returns a body", async () => {
    const f = await fixture({
      "project/.pi/rules/style.md": "---\nalwaysApply: true\n---\nIndent with tabs.",
      "project/.pi/rules/api.md": "---\ndescription: How HTTP handlers are structured\n---\nHandlers return Result.",
      "agent/rules/personal.md": "---\ndescription: Personal commit style\n---\nWrite short subjects.",
    });
    f.faux.setResponses([f.tool("read_rule", { name: "api" }), f.text("Read it."), f.text("Second run.")]);
    await f.session.prompt("First prompt.");
    await f.session.prompt("Second prompt.");
    expect(f.seen).toHaveLength(3);
    for (const context of f.seen) {
      // An unchanged section means Pi never appends a patching system message: the prefix stays cacheable.
      expect(systemMessages(context)).toHaveLength(1);
      const prompt = getSystemMessageText(systemMessages(context)[0] as Parameters<typeof getSystemMessageText>[0]);
      expect(prompt).toContain("<pi_rules>\nThese rules come from the project's and the user's rule files.");
      expect(prompt).toContain('<rule name="style">\nIndent with tabs.\n</rule>');
      expect(prompt).toContain(
        "- api: How HTTP handlers are structured\n- personal: Personal commit style\n</pi_rules>",
      );
      expect(prompt).not.toContain("Handlers return Result.");
    }
    const [read] = toolResults(f, "read_rule");
    expect(read?.isError).toBe(false);
    expect(read && resultText(read)).toBe('Rule "api" (.pi/rules):\n\nHandlers return Result.');
    expect(deliveries(f).map((entry) => entry.type === "custom" && entry.data)).toEqual([
      { v: 1, via: "read", rules: ["api"] },
    ]);
    expect(f.errors).toEqual([]);
  });

  it("does not read project rules in an untrusted project but keeps user rules", async () => {
    const f = await fixture(
      {
        "project/.pi/rules/project.md": "---\nalwaysApply: true\n---\nProject instruction.",
        "agent/rules/user.md": "---\nalwaysApply: true\n---\nUser instruction.",
      },
      { trusted: false },
    );
    f.faux.setResponses([f.text("ok")]);
    await f.session.prompt("Hello.");
    const prompt = JSON.stringify(f.seen[0]);
    expect(prompt).toContain("User instruction.");
    expect(prompt).not.toContain("Project instruction.");
  });

  it("blocks a matching call before it runs, quoting the rule once per branch", async () => {
    const f = await fixture({
      "project/.pi/rules/no-force-push.md":
        "---\ncondition: 'git push .*--force'\nscope: tool:bash\nenforce: block\n---\nNever force-push; ask the user first.",
    });
    const command = "touch ran && git push origin --force";
    f.faux.setResponses([f.tool("bash", { command }), f.tool("bash", { command }), f.text("Stopped.")]);
    await f.session.prompt("Publish the branch.");
    const results = toolResults(f, "bash");
    expect(results.map((result) => result.isError)).toEqual([true, true]);
    expect(resultText(results[0] as (typeof results)[number])).toContain('Blocked by rule "no-force-push"');
    expect(resultText(results[0] as (typeof results)[number])).toContain(
      '<rule name="no-force-push">\nNever force-push; ask the user first.\n</rule>',
    );
    expect(resultText(results[1] as (typeof results)[number])).toContain(
      'Rule "no-force-push" was quoted earlier on this branch; read_rule shows it again.',
    );
    expect(resultText(results[1] as (typeof results)[number])).not.toContain("Never force-push");
    expect(existsSync(join(f.cwd, "ran"))).toBe(false);
    expect(deliveries(f)).toHaveLength(1);
    expect(f.errors).toEqual([]);
  });

  it("reminds once per branch, survives reload, and re-arms on a branch where it never fired", async () => {
    const f = await fixture({
      "project/.pi/rules/no-any.md":
        "---\ncondition: ':\\s*any\\b'\nscope: tool:write(*.ts)\ninterruptMode: never\n---\nUse unknown instead of any.",
    });
    const tag = '<rule-reminder rule="no-any"';
    f.faux.setResponses([f.text("Hi.")]);
    await f.session.prompt("Hello.");
    const beforeAnyReminder = f.session.sessionManager.getLeafId();
    if (!beforeAnyReminder) throw new Error("missing leaf");

    const violate = async (file: string) => {
      f.faux.setResponses([f.tool("write", { path: file, content: "let x: any = 1;\n" }), f.text("Written.")]);
      await f.session.prompt(`Write ${file}.`);
      return f.seen.at(-1);
    };

    const first = await violate("a.ts");
    expect(existsSync(join(f.cwd, "a.ts"))).toBe(true); // remind lets the call run
    expect(occurrences(first, tag)).toBe(1);
    expect(JSON.stringify(first)).toContain("Use unknown instead of any.");
    const steer = f.session.messages.find((message) => message.role === "custom");
    expect(steer).toMatchObject({
      customType: REMINDER_MESSAGE,
      display: false,
      details: { rules: ["no-any"] },
    });

    expect(occurrences(await violate("b.ts"), tag)).toBe(1); // only the earlier reminder, still in history
    await f.session.reload();
    expect(occurrences(await violate("c.ts"), tag)).toBe(1); // not re-delivered after /reload
    expect(deliveries(f)).toHaveLength(1);

    await f.session.navigateTree(beforeAnyReminder);
    expect(deliveries(f)).toHaveLength(0);
    const rearmed = await violate("d.ts");
    expect(occurrences(rearmed, tag)).toBe(1); // delivered again: this branch never saw it
    expect(deliveries(f)).toHaveLength(1);
    expect(f.errors).toEqual([]);
  });

  it("delivers a once rule a single time when one response makes two matching calls", async () => {
    const f = await fixture({
      "project/.pi/rules/no-console.md": "---\ncondition: console\\.log\nscope: tool:write\n---\nUse the logger.",
    });
    const call = (file: string) => fauxToolCall("write", { path: file, content: "console.log(1);\n" });
    f.faux.setResponses([
      f.respond(fauxAssistantMessage([call("x.ts"), call("y.ts")], { stopReason: "toolUse" })),
      f.text("Done."),
    ]);
    await f.session.prompt("Write two files.");
    expect(toolResults(f, "write").map((result) => result.isError)).toEqual([false, false]);
    expect(deliveries(f)).toHaveLength(1);
    expect(occurrences(f.seen.at(-1), '<rule-reminder rule="no-console"')).toBe(1);
  });

  it("re-delivers an after-gap rule only once the gap in assistant turns has passed", async () => {
    const f = await fixture({
      "project/.pi/rules/gap.md":
        "---\ncondition: TODO\nscope: tool:write\nrepeatMode: after-gap\nrepeatGap: 2\n---\nTrack TODOs in the issue tracker.",
    });
    const write = (file: string) => f.tool("write", { path: file, content: "// TODO later\n" });
    f.faux.setResponses([write("1.ts"), write("2.ts"), write("3.ts"), f.text("Done.")]);
    await f.session.prompt("Write three files.");
    const ledger = readLedger(f.session.sessionManager.getBranch());
    expect(ledger.deliveries.get("gap")).toBe(2); // turns 1 and 3; turn 2 was inside the gap
    expect(occurrences(f.seen.at(-1), '<rule-reminder rule="gap"')).toBe(2);
  });

  it("records 65 matching offers in bounded batches and recovers them on reload without reoffering", async () => {
    const files: Record<string, string> = { "project/src/a.ts": "export {};" };
    for (let index = 0; index < 65; index++) {
      files[`project/.pi/rules/rule-${index}.md`] =
        "---\ndescription: TypeScript conventions\nglobs: src/**/*.ts\n---\nUse explicit types.";
    }
    const f = await fixture(files);
    const read = async () => {
      f.faux.setResponses([f.tool("read", { path: "src/a.ts" }), f.text("Read.")]);
      await f.session.prompt("Read the file.");
    };
    await read();
    expect(
      deliveries(f).map((entry) => entry.type === "custom" && (entry.data as { rules: string[] }).rules.length),
    ).toEqual([64, 1]);
    expect(readLedger(f.session.sessionManager.getBranch()).lastDelivered.size).toBe(65);
    await read();
    await f.session.reload();
    await read();
    expect(deliveries(f)).toHaveLength(2);
    expect([...readLedger(f.session.sessionManager.getBranch()).deliveries.values()]).toEqual(Array(65).fill(1));
    expect(f.errors).toEqual([]);
  });

  it.each(["reload", "tree"])(
    "cancelled queued reminders do not consume once, including across %s",
    async (recovery) => {
      const queued = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let armed = true;
      const f = await fixture(
        {
          "agent/rules/cancel.md": "---\ncondition: CANCEL_ME\nscope: tool:bash\n---\nCANCEL_RULE_BODY",
        },
        {
          probe: (pi) =>
            pi.on("tool_call", async (event) => {
              if (armed && event.toolName === "bash") {
                armed = false;
                queued.resolve();
                await release.promise;
              }
            }),
        },
      );
      const before = f.session.sessionManager.appendMessage({
        role: "user",
        content: "before cancellation",
        timestamp: Date.now(),
      });
      f.faux.setResponses([f.tool("bash", { command: "printf CANCEL_ME" }), f.text("should not run")]);
      const prompting = f.session.prompt("first");
      await queued.promise;
      f.session.clearQueue();
      const aborting = f.session.abort();
      release.resolve();
      await Promise.all([prompting, aborting]);
      expect(deliveries(f)).toHaveLength(0);
      expect(
        f.session.messages.some((message) => message.role === "custom" && message.customType === REMINDER_MESSAGE),
      ).toBe(false);
      if (recovery === "reload") await f.session.reload();
      else expect((await f.session.navigateTree(before)).cancelled).toBe(false);
      f.faux.setResponses([f.tool("bash", { command: "printf CANCEL_ME" }), f.text("done")]);
      await f.session.prompt("retry");
      expect(deliveries(f)).toHaveLength(1);
      expect(occurrences(f.seen.at(-1), "CANCEL_RULE_BODY")).toBe(1);
    },
  );

  it("file URLs match native write targets, including escaped space/unicode and block scope", async () => {
    const f = await fixture({
      "agent/rules/no-write.md":
        "---\ncondition: BLOCK_ME\nscope: tool:write(src/**/*.ts)\nenforce: block\n---\nDo not write BLOCK_ME.",
    });
    const inside = pathToFileURL(join(f.cwd, "src", "space 雪.ts")).href;
    const outside = pathToFileURL(join(f.cwd, "outside.ts")).href;
    const whitespace = pathToFileURL(join(f.cwd, "src", " space 雪.ts ")).href;
    f.faux.setResponses([
      f.tool("write", { path: inside, content: "BLOCK_ME" }),
      f.tool("write", { path: outside, content: "BLOCK_ME" }),
      f.tool("write", { path: whitespace, content: "BLOCK_ME" }),
      f.tool("write", { path: whitespace, content: "allowed" }),
      f.text("done"),
    ]);
    await f.session.prompt("write");
    // Trailing filename whitespace is significant: "*.ts" does not match "*.ts ".
    expect(toolResults(f, "write").map((result) => result.isError)).toEqual([true, false, false, false]);
    expect(readFileSync(join(f.cwd, "src", " space 雪.ts "), "utf8")).toBe("allowed");
    expect(existsSync(join(f.cwd, "src", "space 雪.ts"))).toBe(false);
    expect(existsSync(join(f.cwd, "outside.ts"))).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "literal file: and uppercase FILE:// paths match the actual native write target",
    async () => {
      const f = await fixture({
        "agent/rules/no-literal-write.md":
          "---\ncondition: BLOCK_ME\nscope: tool:write(file:src/**/*.ts), tool:write(FILE:/**/*.ts), tool:write(file:/src/**/*.ts)\nenforce: block\n---\nDo not write BLOCK_ME.",
      });
      const paths = ["file:src/a.ts", "FILE://src/a.ts", "file:/src/space 雪.ts", " file:src/space 雪.ts "];
      f.faux.setResponses([
        ...paths.map((path) => f.tool("write", { path, content: "BLOCK_ME" })),
        ...paths.map((path) => f.tool("write", { path, content: "allowed" })),
        f.text("done"),
      ]);
      await f.session.prompt("write literal paths");
      expect(toolResults(f, "write").map((result) => result.isError)).toEqual([
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
      ]);
      for (const path of paths) expect(readFileSync(join(f.cwd, path), "utf8")).toBe("allowed");
      expect(f.errors).toEqual([]);
    },
  );

  it("inactive read_rule offers index-less glob files and repeated block references without widening tools", async () => {
    const f = await fixture({
      "agent/rules/glob.md": "---\nglobs: src/**/*.tsx\n---\nGLOB_BODY",
      "agent/rules/block.md": "---\ncondition: BLOCK_ME\nscope: tool:write\nenforce: block\n---\nBLOCK_BODY",
      "project/src/App.tsx": "export {};",
    });
    f.session.setActiveToolsByName(["read", "write"]);
    f.faux.setResponses([
      f.tool("read", { path: "src/App.tsx" }),
      f.tool("write", { path: "x", content: "BLOCK_ME" }),
      f.tool("write", { path: "x", content: "BLOCK_ME" }),
      f.text("done"),
    ]);
    await f.session.prompt("read then write");
    const offers = f.session.messages.filter(
      (message) => message.role === "custom" && message.customType === REMINDER_MESSAGE,
    );
    expect(JSON.stringify(offers)).toContain("/rules/glob.md");
    expect(JSON.stringify(offers)).not.toContain("Read it with read_rule");
    const repeated = toolResults(f, "write")[1];
    expect(repeated && resultText(repeated)).toContain("/rules/block.md");
    expect(repeated && resultText(repeated)).not.toContain("read_rule");
    expect(f.session.getActiveToolNames()).toEqual(["read", "write"]);
  });

  it("offers a glob rule by name when a tool touches a matching file", async () => {
    const f = await fixture({
      "project/.cursor/rules/react.mdc":
        "---\ndescription: React component conventions\nglobs: src/**/*.tsx\nalwaysApply: false\n---\nUse function components.",
      "project/src/App.tsx": "export const App = () => null;\n",
    });
    f.faux.setResponses([f.tool("read", { path: "src/App.tsx" }), f.text("Read.")]);
    await f.session.prompt("Look at the app.");
    const last = JSON.stringify(f.seen.at(-1));
    expect(last).toContain('<rule-offer rule=\\"react\\" path=\\"src/App.tsx\\">');
    expect(last).toContain("React component conventions. Read it with read_rule before changing the file.");
    expect(last).not.toContain("Use function components.");
    expect(deliveries(f)).toHaveLength(1);
  });
});

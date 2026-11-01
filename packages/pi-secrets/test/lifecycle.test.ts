import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import secrets, { PLACEHOLDER_GUIDELINE, registerSecrets, SECRETS_COMMAND } from "../src/index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ENV_VALUE = "env-secret-value-1";
const CONFIG_VALUE = "config-secret-value-2";
const PATTERN_VALUE = "CORP_ABCDEFGHIJ";

function harness(options: { trusted?: boolean; userConfig?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-secrets-lifecycle-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(agentDir, "pi-secrets.json"),
    options.userConfig ?? JSON.stringify({ secrets: [{ name: "Deploy", value: CONFIG_VALUE }] }),
  );
  writeFileSync(
    join(cwd, ".pi", "pi-secrets.json"),
    JSON.stringify({
      secrets: [{ name: "Corp", pattern: "corp_[a-z]{10}", flags: "i" }],
    }),
  );
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
  };
  const notes: [string, string][] = [];
  let aborted = 0;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notes.push([message, level]),
    },
    isProjectTrusted: () => options.trusted ?? true,
    abort: () => {
      aborted += 1;
    },
  };
  registerSecrets(pi as never, {
    env: () => ({ SERVICE_TOKEN: ENV_VALUE, HOME: "/home/someone" }),
    agentDir: () => agentDir,
  });
  const emit = (event: string, payload: unknown = { type: event }) =>
    (handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
  const status = async () => {
    await commands.get(SECRETS_COMMAND)?.handler("", ctx);
    return notes.at(-1)?.[0] ?? "";
  };
  return {
    emit,
    status,
    notes,
    handlers,
    get aborted() {
      return aborted;
    },
  };
}

describe("extension lifecycle", () => {
  it("registers its hooks and the /secrets command through the default export", () => {
    const events: string[] = [];
    const commands: string[] = [];
    secrets({
      on: (event: string) => events.push(event),
      registerCommand: (name: string) => commands.push(name),
    } as never);
    expect(events).toEqual([
      "session_start",
      "session_shutdown",
      "before_agent_start",
      "context_with_system",
      "tool_call",
    ]);
    expect(commands).toEqual(["secrets"]);
  });

  it("obfuscates requests, restores tool input and reports counts without values", async () => {
    const h = harness();
    h.emit("session_start");
    expect(h.notes).toEqual([]);
    const [result] = h.emit("context_with_system", {
      type: "context_with_system",
      messages: [
        { role: "system", content: "prompt", timestamp: 0 },
        {
          role: "user",
          content: `${ENV_VALUE} ${CONFIG_VALUE} ${PATTERN_VALUE}`,
          timestamp: 1,
        },
      ],
    }) as [{ messages: { content: string }[] }];
    const sent = result.messages[1]?.content ?? "";
    expect(sent).toMatch(/^\$\$SERVICE_TOKEN_[A-Z0-9]{12}\$\$ \$\$DEPLOY_[A-Z0-9]{12}\$\$ \$\$CORP_[A-Z0-9]{12}\$\$$/);

    const input = { command: `run ${sent}`, nested: { list: [sent] } };
    h.emit("tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "1",
      input,
    });
    const original = `${ENV_VALUE} ${CONFIG_VALUE} ${PATTERN_VALUE}`;
    expect(input).toEqual({
      command: `run ${original}`,
      nested: { list: [original] },
    });

    const report = await h.status();
    expect(report).toContain("1 configured values");
    expect(report).toContain("1 environment variables");
    expect(report).toContain("1 placeholder key");
    expect(report).toContain("1 found by configured patterns");
    expect(report).toContain(
      "Configuration (pi-secrets.json): user: 1 value(s), 0 pattern(s); project: 0 value(s), 1 pattern(s)",
    );
    expect(report).toContain("Requests checked: 1; replacements in the last request: 3");
    expect(report).toContain("Tool calls restored: 1 (6 placeholder(s))");
    expect(report).toContain("Placeholder key: persistent");
    for (const value of [ENV_VALUE, CONFIG_VALUE, PATTERN_VALUE, "$$", "SERVICE_TOKEN", "DEPLOY"]) {
      expect(report).not.toContain(value);
    }
  });

  it("ignores an untrusted project's configuration and reports configuration problems by index", async () => {
    const h = harness({
      trusted: false,
      userConfig: JSON.stringify({ secrets: [{ value: "short" }] }),
    });
    h.emit("session_start");
    expect(h.notes).toEqual([["pi-secrets: 1 configuration problem(s); run /secrets", "warning"]]);
    const report = await h.status();
    expect(report).toContain("user: 0 value(s), 0 pattern(s); project: untrusted");
    expect(report).toContain(
      'Warning: user pi-secrets.json secrets[0]: "value" must be a string of at least 8 characters',
    );
  });

  it("withholds a request it cannot rewrite", async () => {
    const h = harness();
    h.emit("session_start");
    const system = { role: "system", content: "prompt", timestamp: 0 };
    const broken = {
      role: "user",
      timestamp: 1,
      get content(): string {
        throw new Error("unreadable");
      },
    };
    const [result] = h.emit("context_with_system", {
      type: "context_with_system",
      messages: [system, broken],
    });
    expect(result).toEqual({ messages: [system] });
    expect(h.aborted).toBe(1);
    expect(h.notes.at(-1)).toEqual(["pi-secrets could not rewrite the request; it was withheld.", "error"]);
    expect(await h.status()).toContain("Requests withheld after a rewrite failure: 1");
  });

  it("adds the placeholder guideline once and forgets the session at shutdown", async () => {
    const h = harness();
    h.emit("session_start");
    const event = {
      type: "before_agent_start",
      systemPromptOptions: { promptGuidelines: ["existing"] },
    };
    h.emit("before_agent_start", event);
    h.emit("before_agent_start", event);
    expect(event.systemPromptOptions.promptGuidelines).toEqual(["existing", PLACEHOLDER_GUIDELINE]);
    h.emit("session_shutdown");
    expect(await h.status()).toBe("Secret obfuscation is not active for this session.");
  });
});

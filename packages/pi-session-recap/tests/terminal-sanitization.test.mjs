import assert from "node:assert/strict";
import test from "node:test";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import sessionRecap, { buildRecapContext } from "../index.ts";

// A hijacked OSC 8 hyperlink, a title rewrite, a screen clear and a bidi override.
// Every one of these is a terminal command, not text.
const OSC_HIJACK = "\u001b]8;;http://attacker.invalid\u0007pay me\u001b]8;;\u0007";
const TITLE_HIJACK = "\u001b]0;pwned\u0007";
const CLEAR_SCREEN = "\u001b[2J";
const BIDI_OVERRIDE = "\u202e";

function controlCharacters(value, { allowLineBreaks = false } = {}) {
  const found = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (allowLineBreaks && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)) continue;
    const unsafe =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (unsafe) found.push(`U+${codePoint.toString(16).padStart(4, "0")}`);
  }
  return found;
}

test("tool output is neutralized before the recap prompt truncates it", () => {
  // Straddle the 2000-character cut, so a naive slice would hand the model the front
  // half of an escape sequence with nothing to close it.
  const prefix = `${"A".repeat(1000)}${TITLE_HIJACK}\nreadable line\n`;
  const pad = "A".repeat(1999 - prefix.length);
  const payload = `${prefix}${pad}${OSC_HIJACK}\n${"B".repeat(4000)}${CLEAR_SCREEN}`;
  const entries = [
    { type: "message", message: { role: "user", content: "read the file", timestamp: 1 } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.txt" } }],
        timestamp: 2,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: payload }],
        isError: false,
        timestamp: 3,
      },
    },
  ];

  const context = buildRecapContext(entries, entries);
  const toolResult = context.messages.find((message) => message.role === "toolResult");
  assert.ok(toolResult);
  const text = toolResult.content[0].text;

  assert.deepEqual(controlCharacters(text, { allowLineBreaks: true }), []);
  // Line structure survives, so the model still reads tool output as tool output.
  assert.match(text, /\nreadable line\n/u);
  assert.match(text, /A{100}/u);
});

test("the initial request is neutralized before its middle is elided", () => {
  const long = `${"start ".repeat(900)}${TITLE_HIJACK}${"end ".repeat(900)}`;
  const initialEntry = { type: "message", message: { role: "user", content: long, timestamp: 1 } };
  const contextEntries = [{ type: "message", message: { role: "user", content: "carry on", timestamp: 2 } }];

  const context = buildRecapContext(contextEntries, [initialEntry, ...contextEntries]);
  assert.ok(context.broaderContext);
  assert.deepEqual(controlCharacters(context.broaderContext, { allowLineBreaks: true }), []);
  assert.match(context.broaderContext, /^Initial user request:\n/u);
  assert.match(context.broaderContext, /middle of initial request omitted/u);
});

test("a compaction summary carrying an escape sequence never reaches the prompt intact", () => {
  const entries = [
    { type: "compaction", summary: `Summary${CLEAR_SCREEN}${BIDI_OVERRIDE} of prior work` },
    { type: "message", message: { role: "user", content: "keep going", timestamp: 1 } },
  ];

  const context = buildRecapContext(entries, entries);
  assert.ok(context.broaderContext);
  assert.deepEqual(controlCharacters(context.broaderContext, { allowLineBreaks: true }), []);
  assert.match(context.broaderContext, /Summary/u);
});

test("a model recap cannot drive the terminal through the recap widget", async () => {
  const recapText = `Next: finish the parser.${OSC_HIJACK}${CLEAR_SCREEN}${BIDI_OVERRIDE}`;
  registerApiProvider({
    api: "anthropic-messages",
    stream: () => ({
      result: async () => ({ role: "assistant", content: [{ type: "text", text: recapText }] }),
    }),
    streamSimple: () => ({
      result: async () => ({ role: "assistant", content: [{ type: "text", text: recapText }] }),
    }),
  });

  const branch = [
    { type: "message", message: { role: "user", content: "Fix the parser." } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I inspected the parser and prepared the next concrete change, so the recap has enough completed work to summarize without relying on terminal focus events.",
          },
        ],
      },
    },
  ];

  const widgets = [];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: {
      id: "claude-haiku-4-5",
      name: "Claude Haiku",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "http://localhost.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => branch,
    },
    ui: {
      setStatus() {},
      setWidget(_key, content) {
        if (Array.isArray(content)) widgets.push(content);
      },
    },
  };

  const commands = new Map();
  const pi = {
    on: () => {},
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: () => {},
    getFlag: () => undefined,
  };
  sessionRecap(pi);
  await commands.get("recap").handler("", ctx);

  assert.equal(widgets.length, 1);
  const [header, body] = widgets[0];
  assert.equal(header, "✦ recap");
  assert.deepEqual(controlCharacters(body), []);
  assert.match(body, /Next: finish the parser\./u);
});

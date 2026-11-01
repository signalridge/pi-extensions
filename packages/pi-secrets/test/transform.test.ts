import { type ContextWithSystemEvent, convertToLlm } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { mapJsonStrings, mapMessages, mapStringsInPlace } from "../src/transform.js";

type Messages = ContextWithSystemEvent["messages"];

const SECRET = "hunter2-hunter2";
const mask = (text: string) => text.replaceAll(SECRET, "[S]");

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {},
};

function transcript(): Messages {
  return [
    { role: "system", content: `prompt mentions ${SECRET}`, timestamp: 0 },
    { role: "user", content: `plain ${SECRET}`, timestamp: 1 },
    {
      role: "user",
      content: [
        { type: "text", text: `part ${SECRET}` },
        { type: "image", data: SECRET, mimeType: "image/png" },
      ],
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: `thought ${SECRET}`,
          thinkingSignature: "sig",
        },
        { type: "thinking", thinking: "unchanged", thinkingSignature: "keep" },
        {
          type: "thinking",
          thinking: SECRET,
          thinkingSignature: "opaque",
          redacted: true,
        },
        { type: "text", text: `said ${SECRET}` },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: `echo ${SECRET}`, env: { list: [SECRET, 3] } },
          thoughtSignature: "gemini",
        },
        {
          type: "toolCall",
          id: "call-2",
          name: "read",
          arguments: { path: "README.md" },
          thoughtSignature: "kept",
        },
      ],
      api: "faux",
      provider: "faux",
      model: "m",
      usage,
      stopReason: "toolUse",
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: `${SECRET}\n` }],
      isError: false,
      timestamp: 4,
    },
    {
      role: "custom",
      customType: "note",
      content: `custom ${SECRET}`,
      display: true,
      timestamp: 5,
    },
    {
      role: "bashExecution",
      command: `export X=${SECRET}`,
      output: SECRET,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 6,
    },
    {
      role: "branchSummary",
      summary: `branch ${SECRET}`,
      fromId: null,
      timestamp: 7,
    },
    {
      role: "compactionSummary",
      summary: `compacted ${SECRET}`,
      tokensBefore: 10,
      timestamp: 8,
    },
    { role: "user", content: "nothing to hide", timestamp: 9 },
  ] as unknown as Messages;
}

describe("mapMessages", () => {
  it("rewrites every provider-visible conversation text without mutating the input", () => {
    const input = deepFreeze(transcript());
    const snapshot = structuredClone(input);
    const { messages, changed } = mapMessages(input, mask);
    expect(changed).toBe(true);
    expect(input).toEqual(snapshot);

    const [system, plain, parts, assistant, toolResult, custom, bash, branch, compaction, untouched] =
      messages as unknown as Record<string, unknown>[];
    expect(system).toBe(input[0]);
    expect(untouched).toBe(input[9]);
    expect(plain?.content).toBe("plain [S]");
    expect(parts?.content).toEqual([
      { type: "text", text: "part [S]" },
      { type: "image", data: SECRET, mimeType: "image/png" },
    ]);
    expect(assistant?.content).toEqual([
      {
        type: "thinking",
        thinking: "thought [S]",
        thinkingSignature: undefined,
      },
      { type: "thinking", thinking: "unchanged", thinkingSignature: "keep" },
      {
        type: "thinking",
        thinking: SECRET,
        thinkingSignature: "opaque",
        redacted: true,
      },
      { type: "text", text: "said [S]" },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "echo [S]", env: { list: ["[S]", 3] } },
        thoughtSignature: undefined,
      },
      {
        type: "toolCall",
        id: "call-2",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "kept",
      },
    ]);
    expect(toolResult?.content).toEqual([{ type: "text", text: "[S]\n" }]);
    expect(custom?.content).toBe("custom [S]");
    expect(bash).toMatchObject({ command: "export X=[S]", output: "[S]" });
    expect(branch?.summary).toBe("branch [S]");
    expect(compaction?.summary).toBe("compacted [S]");
  });

  it("protects fullOutputPath before Pi appends it to truncated ! output", () => {
    const input = deepFreeze<Messages>([
      {
        role: "bashExecution",
        command: "echo hello",
        output: "hello",
        exitCode: 0,
        cancelled: false,
        truncated: true,
        fullOutputPath: `/tmp/${SECRET}/pi-bash-demo.log`,
        timestamp: 0,
      },
    ]);
    const snapshot = structuredClone(input);
    // Establish that the actual host conversion would expose the path.
    expect(JSON.stringify(convertToLlm(input))).toContain(SECRET);
    const mapped = mapMessages(input, mask);
    expect(mapped.changed).toBe(true);
    const providerText = JSON.stringify(convertToLlm(mapped.messages));
    expect(providerText).toContain("Full output: /tmp/[S]/pi-bash-demo.log");
    expect(providerText).not.toContain(SECRET);
    expect(input).toEqual(snapshot);
  });

  it("keeps bash message identity and optional path presence when unchanged", () => {
    const base = {
      role: "bashExecution" as const,
      command: "echo hello",
      output: "hello",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    };
    const input = deepFreeze<Messages>([
      base,
      { ...base, fullOutputPath: "/tmp/safe.log" },
      { ...base, fullOutputPath: undefined },
    ]);
    const result = mapMessages(input, mask);
    expect(result.changed).toBe(false);
    expect(result.messages[0]).toBe(input[0]);
    expect(result.messages[1]).toBe(input[1]);
    expect(result.messages[2]).toBe(input[2]);
    expect(Object.hasOwn(result.messages[0] ?? {}, "fullOutputPath")).toBe(false);
    expect(Object.hasOwn(result.messages[2] ?? {}, "fullOutputPath")).toBe(true);
    const changed = mapMessages([{ ...base, command: SECRET }], mask).messages[0];
    expect(changed).toMatchObject({ command: "[S]" });
    expect(Object.hasOwn(changed ?? {}, "fullOutputPath")).toBe(false);
  });

  it("reports no change and keeps identities when nothing matches", () => {
    const input = transcript().slice(9);
    expect(input).toHaveLength(1);
    const result = mapMessages(input, mask);
    expect(result.changed).toBe(false);
    expect(result.messages[0]).toBe(input[0]);
  });
});

describe("JSON string helpers", () => {
  it("copy only the changed branches", () => {
    const value = {
      keep: { a: "x" },
      change: [`${SECRET}`, { deep: SECRET }],
      n: 1,
    };
    const mapped = mapJsonStrings(value, mask) as typeof value;
    expect(mapped).toEqual({
      keep: { a: "x" },
      change: ["[S]", { deep: "[S]" }],
      n: 1,
    });
    expect(mapped.keep).toBe(value.keep);
    expect(mapJsonStrings(value.keep, mask)).toBe(value.keep);
  });

  it("restore nested input in place, keeping object identity and keys", () => {
    const nested = {
      headers: { [SECRET]: SECRET },
      list: [SECRET, 7, null, [SECRET]],
    };
    const input: Record<string, unknown> = { command: SECRET, nested };
    mapStringsInPlace(input, mask);
    expect(input).toEqual({
      command: "[S]",
      nested: { headers: { [SECRET]: "[S]" }, list: ["[S]", 7, null, ["[S]"]] },
    });
    expect(input.nested).toBe(nested);
  });
});

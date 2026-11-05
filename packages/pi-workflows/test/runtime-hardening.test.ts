import { describe, expect, it } from "vitest";
import { WorkflowErrorCode } from "../src/errors.js";
import { findJsonBlock, runWorkflow, validateJsonSchema } from "../src/runtime.js";

// Deliberately simple reference for compatibility checks, never used in production.
function referenceBlock(text: string): string | undefined {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
      else if (char === "}" || char === "]") {
        if (stack.pop() !== char) break;
        if (stack.length === 0) return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

describe("linear JSON extraction", () => {
  it.each([
    'prose before {"items":[{"text":"a\\"}[]"}]} after',
    '```json\n[{"ok":true}]\n```',
    '{{"ok":true}',
    '[bad} then {"ok":true}',
    '{"unfinished quote [1,2] tail',
    '"quoted prose" [{"nested":[]}]',
    '{"brackets":"[{}]"} [2]',
    "{{[}[]",
    "no JSON here",
    "[[[[",
  ])("preserves escaped/nested/prose and malformed-prefix behavior: %s", (text) => {
    expect(findJsonBlock(text)).toBe(referenceBlock(text));
  });

  it("matches the previous scanner exhaustively on short malformed inputs", () => {
    const alphabet = ["{", "}", "[", "]", '"', "\\", "x"];
    for (let size = 0; size <= 5; size++) {
      const count = alphabet.length ** size;
      for (let code = 0; code < count; code++) {
        let remaining = code;
        let text = "";
        for (let i = 0; i < size; i++) {
          text += alphabet[remaining % alphabet.length];
          remaining = Math.floor(remaining / alphabet.length);
        }
        expect(findJsonBlock(text), JSON.stringify(text)).toBe(referenceBlock(text));
      }
    }
  });

  it("extracts large malformed-prefix replies without repeated suffix scans", () => {
    const started = performance.now();
    expect(findJsonBlock("[".repeat(1_000_000))).toBeUndefined();
    expect(findJsonBlock(`${"{".repeat(1_000_000)}{"ok":true}`)).toBe('{"ok":true}');
    expect(findJsonBlock(`{${"[]".repeat(500_000)}`)).toBe("[]");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("still sends malformed large output to bounded repair and preserves exhaustion", async () => {
    const prompts: string[] = [];
    const script =
      'export const meta={name:"large-json",description:"test"}; return await agent("work",{schema:{type:"object",required:["ok"]}});';
    const options = {
      agentRetries: 1,
      agent: {
        run: async (prompt: string) => {
          prompts.push(prompt);
          return prompts.length === 1 ? "[".repeat(400_000) : 'prefix {"ok":true} suffix';
        },
      },
    };
    expect((await runWorkflow(script, options)).result).toEqual({ ok: true });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("no JSON value found in the reply");
    let calls = 0;
    await expect(
      runWorkflow(script, {
        agentRetries: 1,
        agent: {
          run: async () => {
            calls++;
            return "{".repeat(400_000);
          },
        },
      }),
    ).rejects.toMatchObject({ code: WorkflowErrorCode.SCHEMA_NONCOMPLIANCE });
    expect(calls).toBe(2);
  });
});

describe("conjunctive bounded JSON Schema", () => {
  it.each([
    [2, { const: 2, type: "string" }, "expected type string"],
    [2, { const: 2, enum: [3] }, "value not in enum"],
    ["x", { enum: ["x"], minLength: 2 }, "shorter than 2"],
    ["long", { const: "long", maxLength: 2 }, "longer than 2"],
    [2, { enum: [2], minimum: 3 }, "below minimum 3"],
    [2, { const: 2, maximum: 1 }, "above maximum 1"],
    [[1], { enum: [[1]], minItems: 2 }, "fewer than 2 items"],
    [[1, 2], { const: [1, 2], maxItems: 1 }, "more than 1 items"],
    [[1], { enum: [[1]], items: { type: "string" } }, "expected type string"],
    [{ n: 1 }, { const: { n: 1 }, required: ["missing"] }, "missing required property"],
    [{ n: 1 }, { enum: [{ n: 1 }], properties: { n: { type: "string" } } }, "expected type string"],
    [{ n: 1 }, { const: { n: 1 }, additionalProperties: false }, "unexpected property"],
    [{ n: 1 }, { type: "object", properties: { n: { const: 1, minimum: 2 } } }, "below minimum 2"],
  ])("validates every supported sibling constraint on %j", (value, schema, diagnostic) => {
    expect(validateJsonSchema(value, schema).join("; ")).toContain(diagnostic);
  });

  it("accepts satisfied conjunctive schemas and still rejects unsupported keywords", () => {
    expect(
      validateJsonSchema(
        { n: [2] },
        {
          const: { n: [2] },
          enum: [{ n: [2] }],
          type: "object",
          required: ["n"],
          additionalProperties: false,
          properties: {
            n: { type: "array", minItems: 1, maxItems: 1, items: { type: "integer", minimum: 2, maximum: 2 } },
          },
        },
      ),
    ).toEqual([]);
    expect(() => validateJsonSchema(1, { const: 1, allOf: [] })).toThrow(/unsupported JSON Schema keyword/);
    expect(() => validateJsonSchema({ n: 1 }, { properties: { n: { enum: [1], pattern: "x" } } })).toThrow(
      /unsupported JSON Schema keyword/,
    );
  });

  it("repairs a matching const that fails another constraint, then exhausts", async () => {
    const prompts: string[] = [];
    await expect(
      runWorkflow(
        'export const meta={name:"conjunction",description:"test"}; return await agent("work",{schema:{type:"object",properties:{n:{const:1,minimum:2}}}});',
        {
          agentRetries: 1,
          agent: {
            run: async (prompt) => {
              prompts.push(prompt);
              return '{"n":1}';
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: WorkflowErrorCode.SCHEMA_NONCOMPLIANCE });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("$.n: below minimum 2");
  });
});

// Compile-only contract: included explicitly by tsconfig.integration.json.
import {
  createAgentSession,
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const schema = Type.Object({ path: Type.String(), limit: Type.Optional(Type.Integer()) });
type Args = Static<typeof schema>;
const required: Args = { path: "file" };
// @ts-expect-error required path cannot be omitted
const missing: Args = { limit: 1 };
// @ts-expect-error coercible model strings are not execute's static number type
const raw: Args = { path: "file", limit: "2" };
void [required, missing, raw];

const makeTool = (name: string) =>
  defineTool({
    name,
    label: name,
    description: "Inference qualification",
    parameters: schema,
    async execute(_id, params) {
      const path: string = params.path;
      const limit: number | undefined = params.limit;
      // @ts-expect-error params must not widen to unknown or an unconstrained type
      const wrong: boolean = params.path;
      // @ts-expect-error undeclared fields must not be accepted
      params.absent;
      void [limit, wrong];
      return { content: [{ type: "text", text: path }], details: { ok: true } };
    },
  });

// @ts-expect-error label is a required SDK tool-definition field
const missingLabel: ToolDefinition<typeof schema> = {
  name: "missing-label",
  description: "Required metadata",
  parameters: schema,
  execute: makeTool("delegate").execute,
};
// @ts-expect-error execute results must include the SDK's required details field
const missingDetails: Awaited<ReturnType<ToolDefinition<typeof schema>["execute"]>> = { content: [] };
void [missingLabel, missingDetails];

export function inferenceFixture(pi: ExtensionAPI) {
  pi.registerTool({
    ...makeTool("spread"),
    // Re-anchor schema inference when overriding execute on defineTool's intersection return.
    parameters: schema,
    async execute(_id, params) {
      const path: string = params.path;
      // @ts-expect-error factory spread retains required string inference
      const number: number = params.path;
      void number;
      return { content: [{ type: "text", text: path }], details: { ok: true } };
    },
  });
  pi.registerTool({
    name: "typebox-inline",
    label: "TypeBox",
    description: "Inline TypeBox inference",
    parameters: Type.Object({ count: Type.Integer(), note: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const count: number = params.count;
      const note: string | undefined = params.note;
      // @ts-expect-error required count is numeric, not string
      const text: string = params.count;
      void [note, text];
      return { content: [{ type: "text", text: String(count) }], details: {} };
    },
  });
  const typed: ToolDefinition<typeof schema> = makeTool("typed");
  const customTools = [
    typed,
    makeTool("factory"),
    defineTool({
      name: "array",
      label: "Array",
      description: "customTools contextual inference",
      parameters: Type.Object({ name: Type.String() }),
      async execute(_id, params) {
        const name: string = params.name;
        // @ts-expect-error defineTool preserves params in customTools arrays
        const wrong: number = params.name;
        void wrong;
        return { content: [{ type: "text", text: name }], details: {} };
      },
    }),
  ];
  // Never invoked; checks SDK customTools acceptance without starting a session.
  return () => createAgentSession({ customTools });
}

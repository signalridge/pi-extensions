import { IsSchema, type TSchema } from "typebox";
import { type ApprovalEvents, boundedText } from "./contract.js";

export const APPROVAL_ADAPTER_QUERY_CHANNEL = "signalridge:approvals:adapter:v1";
export interface ApprovalAdapterQuery {
  readonly version: 1;
  readonly toolName: string;
  readonly respond: (adapter: unknown) => void;
}
export interface ApprovalAdapter {
  readonly version: 1;
  readonly toolName: string;
  /** Exact effective public ToolInfo.parameters object, not a copy. */
  readonly parameters: TSchema;
}
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid approval adapter");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error("Invalid approval adapter prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !names.includes(key)) ||
    names.some((key) => !descriptors[key] || !("value" in descriptors[key]))
  )
    throw new Error("Invalid approval adapter fields");
  return value as Record<string, unknown>;
}
function toolName(value: unknown): string {
  const name = boundedText(value, 256);
  if (!/^[a-zA-Z][a-zA-Z0-9_.:-]*$/u.test(name)) throw new Error("Invalid approval adapter tool name");
  return name;
}
export function validateAdapterQuery(value: unknown): ApprovalAdapterQuery {
  const item = fields(value, ["version", "toolName", "respond"]);
  if (item.version !== 1 || typeof item.respond !== "function") throw new Error("Invalid approval adapter query");
  toolName(item.toolName);
  return value as ApprovalAdapterQuery;
}
export function validateAdapter(value: unknown): ApprovalAdapter {
  const item = fields(value, ["version", "toolName", "parameters"]);
  if (item.version !== 1 || !IsSchema(item.parameters)) throw new Error("Invalid approval adapter capability");
  toolName(item.toolName);
  return value as ApprovalAdapter;
}
/** Conservative known input shapes; not detection of arbitrary execution or mutation. */
export function requiresApprovalAdapter(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (Object.hasOwn(input, "command")) return true;
  if (
    Object.hasOwn(input, "path") &&
    ["content", "edits", "oldText", "newText", "old_text", "new_text"].some((key) => Object.hasOwn(input, key))
  )
    return true;
  const nested = Object.getOwnPropertyDescriptor(input, "input");
  return (
    !!nested &&
    "value" in nested &&
    nested.value !== input &&
    !!nested.value &&
    typeof nested.value === "object" &&
    (Object.hasOwn(nested.value, "command") ||
      (Object.hasOwn(nested.value, "path") &&
        ["content", "edits", "oldText", "newText", "old_text", "new_text"].some((key) =>
          Object.hasOwn(nested.value, key),
        )))
  );
}

/** Known schema properties also require admission when optional inputs are
 * filled by downstream normalizers. This is not arbitrary semantic detection.
 * Only root properties and a single input-envelope are inspected, like inputs.
 */
export function schemaRequiresApprovalAdapter(parameters: TSchema): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(parameters, "properties");
  const properties: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  if (requiresApprovalAdapter(properties)) return true;
  const envelope = Object.getOwnPropertyDescriptor(properties, "input");
  if (!envelope || !("value" in envelope) || !envelope.value || typeof envelope.value !== "object") return false;
  const nested = Object.getOwnPropertyDescriptor(envelope.value, "properties");
  return !!nested && "value" in nested && requiresApprovalAdapter(nested.value);
}

/** Trusted cooperative gate attestation, not authorization or an OS sandbox. */
export function queryApprovalAdapter(events: ApprovalEvents, name: string, parameters: TSchema): ApprovalAdapter {
  toolName(name);
  const responses: ApprovalAdapter[] = [];
  let malformed = false;
  let open = true;
  try {
    events.emit(
      APPROVAL_ADAPTER_QUERY_CHANNEL,
      Object.freeze({
        version: 1,
        toolName: name,
        respond: (value: unknown) => {
          if (!open) return;
          try {
            const adapter = validateAdapter(value);
            if (adapter.toolName !== name || adapter.parameters !== parameters)
              throw new Error("Adapter identity mismatch");
            responses.push(adapter);
          } catch {
            malformed = true;
          }
        },
      }),
    );
  } finally {
    open = false;
  }
  if (malformed || responses.length !== 1)
    throw new Error("Command tool requires exactly one live cooperative approval adapter");
  return responses[0];
}

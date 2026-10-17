import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";

export const STATE_TYPE = "pi-todo:state";
export const CONTEXT_TYPE = "pi-todo:context";
export const MAX_BYTES = 64 * 1024;
const StatusSchema = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]);
const Fields = {
  title: Type.String({ minLength: 1, maxLength: 160 }),
  description: Type.Optional(Type.String({ maxLength: 512 })),
  dependencies: Type.Array(Type.String(), { maxItems: 16, uniqueItems: true }),
  status: StatusSchema,
};
export const SnapshotSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  revision: Type.Integer({ minimum: 0 }),
  tasks: Type.Array(Type.Object({ id: Type.String(), ...Fields }), { maxItems: 40 }),
});
const PatchSchema = Type.Object(
  {
    id: Type.String(),
    title: Type.Optional(Fields.title),
    description: Fields.description,
    dependencies: Type.Optional(Fields.dependencies),
    status: Type.Optional(StatusSchema),
  },
  { additionalProperties: false },
);
// Providers require an object-root tool schema. Action-specific requirements are
// checked again in transition(), including after other tool_call handlers run.
export const ParamsSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("add"),
      Type.Literal("update"),
      Type.Literal("remove"),
      Type.Literal("clear"),
    ]),
    baseRevision: Type.Optional(
      Type.Integer({ minimum: 0, description: "REQUIRED for every mutation; current revision from list" }),
    ),
    title: Type.Optional(Fields.title),
    description: Fields.description,
    dependencies: Type.Optional(Fields.dependencies),
    status: Type.Optional(StatusSchema),
    id: Type.Optional(Type.String({ description: "REQUIRED for remove; opaque UUID from list" })),
    updates: Type.Optional(
      Type.Array(PatchSchema, { minItems: 1, maxItems: 40, description: "REQUIRED for update; atomic patches" }),
    ),
  },
  { additionalProperties: false },
);
export type Params = Static<typeof ParamsSchema>;
export type Snapshot = Static<typeof SnapshotSchema>;
export type Task = Snapshot["tasks"][number];
export type Status = Task["status"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unknown field");
}
function text(value: unknown, limit: number, required = false): string {
  if (typeof value !== "string" || [...value].length > limit || (required && !value.trim()))
    throw new Error(`Text must contain ${required ? "1–" : "0–"}${limit} Unicode characters`);
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("baseRevision/revision must be a nonnegative safe integer");
  return value as number;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Expected an opaque UUID task ID");
  return value;
}
function status(value: unknown): Status {
  if (value !== "pending" && value !== "in_progress" && value !== "completed") throw new Error("Invalid status");
  return value;
}
function dependencies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("At most 16 dependency IDs");
  const result = value.map(id);
  if (new Set(result).size !== result.length) throw new Error("Duplicate dependency ID");
  return result;
}
export function copy(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot);
}
/** Preserve JSON data while making bidi controls visible in tool/model text. */
export function modelJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Expected JSON data");
  return text.replace(
    /\p{Bidi_Control}/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function immutable(snapshot: Snapshot): Snapshot {
  for (const task of snapshot.tasks) {
    Object.freeze(task.dependencies);
    Object.freeze(task);
  }
  Object.freeze(snapshot.tasks);
  return Object.freeze(snapshot);
}
export const empty = (): Snapshot => immutable({ schemaVersion: 1, revision: 0, tasks: [] });

/** Parse untrusted persisted data, canonicalize it, and validate the entire next graph. */
export function validateSnapshot(value: unknown): Snapshot {
  if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") > MAX_BYTES)
    throw new Error("Snapshot exceeds 64 KiB UTF-8");
  const source = record(value);
  keys(source, ["schemaVersion", "revision", "tasks"]);
  if (source.schemaVersion !== 1 || !Array.isArray(source.tasks) || source.tasks.length > 40)
    throw new Error("Invalid schema or task limit (40)");
  const tasks = source.tasks.map((value): Task => {
    const task = record(value);
    keys(task, ["id", "title", "description", "dependencies", "status"]);
    return {
      id: id(task.id),
      title: text(task.title, 160, true),
      ...(task.description === undefined ? {} : { description: text(task.description, 512) }),
      dependencies: dependencies(task.dependencies),
      status: status(task.status),
    };
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error("Duplicate task ID");
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (task: Task) => {
    if (visiting.has(task.id)) throw new Error("Cyclic dependencies");
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const dependency of task.dependencies) {
      const prerequisite = byId.get(dependency);
      if (!prerequisite || dependency === task.id) throw new Error("Missing or self dependency");
      if (task.status !== "pending" && prerequisite.status !== "completed")
        throw new Error("Complete prerequisites before progressing/completing a task");
      visit(prerequisite);
    }
    visiting.delete(task.id);
    visited.add(task.id);
  };
  for (const task of tasks) visit(task);
  const result = { schemaVersion: 1 as const, revision: revision(source.revision), tasks };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_BYTES) throw new Error("Snapshot exceeds 64 KiB UTF-8");
  return immutable(result);
}

/** Runtime validation is intentional: tool_call handlers may mutate already-validated arguments. */
export function transition(current: Snapshot, input: unknown, uuid: () => string = randomUUID): Snapshot {
  const params = record(input);
  if (params.action === "list") {
    keys(params, ["action"]);
    return current;
  }
  if (revision(params.baseRevision) !== current.revision)
    throw new Error(`Stale baseRevision; current revision is ${current.revision}. List then retry.`);
  const next = copy(current);
  switch (params.action) {
    case "add": {
      keys(params, ["action", "baseRevision", "title", "description", "dependencies", "status"]);
      const newId = id(uuid());
      if (next.tasks.some((task) => task.id === newId)) throw new Error("UUID collision");
      next.tasks.push({
        id: newId,
        title: text(params.title, 160, true),
        ...(params.description === undefined ? {} : { description: text(params.description, 512) }),
        dependencies: params.dependencies === undefined ? [] : dependencies(params.dependencies),
        status: params.status === undefined ? "pending" : status(params.status),
      });
      break;
    }
    case "update": {
      keys(params, ["action", "baseRevision", "updates"]);
      if (!Array.isArray(params.updates) || !params.updates.length || params.updates.length > 40)
        throw new Error("Expected 1–40 updates");
      const seen = new Set<string>();
      for (const value of params.updates) {
        const patch = record(value);
        keys(patch, ["id", "title", "description", "dependencies", "status"]);
        const task = next.tasks.find((task) => task.id === id(patch.id));
        if (!task || seen.has(task.id)) throw new Error("Unknown or duplicate update ID");
        seen.add(task.id);
        if (patch.title !== undefined) task.title = text(patch.title, 160, true);
        if (patch.description !== undefined) task.description = text(patch.description, 512);
        if (patch.dependencies !== undefined) task.dependencies = dependencies(patch.dependencies);
        if (patch.status !== undefined) task.status = status(patch.status);
      }
      break;
    }
    case "remove": {
      keys(params, ["action", "baseRevision", "id"]);
      const target = id(params.id);
      if (!next.tasks.some((task) => task.id === target)) throw new Error("Unknown task ID");
      next.tasks = next.tasks.filter((task) => task.id !== target);
      break;
    }
    case "clear":
      keys(params, ["action", "baseRevision"]);
      next.tasks = [];
      break;
    default:
      throw new Error("Unknown todo action");
  }
  validateSnapshot(next);
  if (JSON.stringify(next) === JSON.stringify(current)) return current;
  if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("Revision exhausted");
  next.revision++;
  return validateSnapshot(next);
}

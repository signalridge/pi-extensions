import { createHash } from "node:crypto";

export const APPROVAL_VERSION = 1;
export const APPROVAL_QUERY_CHANNEL = "signalridge:approvals:query:v1";
export const APPROVAL_LIFECYCLE_CHANNEL = "signalridge:approvals:lifecycle:v1";
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_REVIEW_BYTES = 64 * 1024;
export const MAX_INPUT_BYTES = 256 * 1024;

export interface ApprovalEvents {
  emit(channel: string, data: unknown): void;
}
export interface ApprovalRequestOptions {
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
}
export interface ApprovalSnapshot {
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface OperationBase {
  readonly source: string;
  readonly toolName: string;
  readonly cwd: string;
  readonly toolCallId: string;
  readonly inputHash: string;
  readonly preview: string;
}
export type ApprovalOperation =
  | (OperationBase & { readonly kind: "command"; readonly command: string })
  | (OperationBase & {
      readonly kind: "write" | "edit";
      readonly toolName: "write" | "edit";
      readonly filePath: string;
      readonly before: ApprovalSnapshot | null;
      readonly after: ApprovalSnapshot;
    });
export interface ApprovalService {
  readonly version: 1;
  readonly id: string;
  request(operation: ApprovalOperation, options: ApprovalRequestOptions): Promise<void>;
}
export interface ApprovalQuery {
  readonly version: 1;
  readonly respond: (service: unknown) => void;
}
export type ApprovalPhase = "waiting" | "respond" | "resolved";
export type ApprovalOutcome = "approved" | "denied" | "cancelled" | "retired" | "expired" | "error";
export interface ApprovalLifecycle {
  readonly version: 1;
  readonly serviceId: string;
  readonly requestId: string;
  readonly source: string;
  readonly toolCallId: string;
  readonly phase: ApprovalPhase;
  readonly outcome?: ApprovalOutcome;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid approval object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid approval prototype");
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !("value" in descriptor)))
    throw new Error("Invalid approval accessor");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key)))
    throw new Error("Unknown approval field");
}
export function boundedText(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > max ||
    /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""))
  ) {
    throw new Error("Invalid or oversized approval text");
  }
  return value;
}
export function approvalId(value: unknown): string {
  const id = boundedText(value, 160);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(id)) throw new Error("Invalid approval identity");
  return id;
}
/** Provider-owned opaque identity: no normalization, truncation or ASCII restriction. */
export function approvalToolCallId(value: unknown): string {
  const id = boundedText(value, 1024);
  if (!id) throw new Error("Empty approval tool-call identity");
  return id;
}
export function hashBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid approval hash");
  return value;
}
export function snapshot(buffer: Buffer): ApprovalSnapshot {
  if (buffer.length > MAX_FILE_BYTES) throw new Error("File exceeds approval size limit");
  const text = buffer.toString("utf8");
  if (text.includes("\0") || !Buffer.from(text, "utf8").equals(buffer)) throw new Error("Binary or invalid UTF-8 file");
  return Object.freeze({ text, bytes: buffer.length, sha256: hashBytes(buffer) });
}
function validateSnapshot(value: unknown): ApprovalSnapshot {
  const item = record(value);
  keys(item, ["text", "bytes", "sha256"]);
  const verified = snapshot(Buffer.from(boundedText(item.text, MAX_FILE_BYTES)));
  if (item.bytes !== verified.bytes || hash(item.sha256) !== verified.sha256) throw new Error("Invalid file snapshot");
  return verified;
}
/** Escape display controls, including bidi/format characters, without removing changes. */
export function escapeDisplay(text: string): string {
  return text
    .replace(/\\/gu, "\\\\")
    .replace(/[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, (char) =>
      char === "\n" ? "\n" : `\\u{${char.codePointAt(0)?.toString(16)}}`,
    );
}
export function validateOperation(value: unknown): ApprovalOperation {
  const item = record(value);
  const base = {
    source: approvalId(item.source),
    cwd: boundedText(item.cwd, 4096),
    toolCallId: approvalToolCallId(item.toolCallId),
    inputHash: hash(item.inputHash),
    preview: boundedText(item.preview, MAX_REVIEW_BYTES),
  };
  if (!base.cwd || !base.preview) throw new Error("Empty approval review");
  if (/[\p{C}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(base.preview.replace(/\n/gu, "")))
    throw new Error("Approval preview contains unescaped display controls");
  const common = ["source", "cwd", "toolCallId", "inputHash", "preview", "kind", "toolName"];
  if (item.kind === "command") {
    keys(item, [...common, "command"]);
    const toolName = boundedText(item.toolName, 80);
    if (!/^[a-zA-Z][a-zA-Z0-9_.:-]*$/u.test(toolName)) throw new Error("Invalid approval tool name");
    return Object.freeze({
      ...base,
      kind: "command",
      toolName,
      command: boundedText(item.command, MAX_INPUT_BYTES),
    });
  }
  if ((item.kind === "edit" || item.kind === "write") && item.toolName === item.kind) {
    keys(item, [...common, "filePath", "before", "after"]);
    const before = item.before === null ? null : validateSnapshot(item.before);
    if (item.kind === "edit" && !before) throw new Error("Edit requires an original file");
    return Object.freeze({
      ...base,
      kind: item.kind,
      toolName: item.kind,
      filePath: boundedText(item.filePath, 4096),
      before,
      after: validateSnapshot(item.after),
    });
  }
  throw new Error("Invalid approval operation kind");
}
export function validateLifecycle(value: unknown): ApprovalLifecycle {
  const item = record(value);
  keys(item, ["version", "serviceId", "requestId", "source", "toolCallId", "phase", "outcome"]);
  if (
    item.version !== 1 ||
    typeof item.phase !== "string" ||
    !["waiting", "respond", "resolved"].includes(item.phase) ||
    (item.outcome !== undefined &&
      (typeof item.outcome !== "string" ||
        !["approved", "denied", "cancelled", "retired", "expired", "error"].includes(item.outcome))) ||
    (item.phase === "waiting" ? item.outcome !== undefined : item.outcome === undefined)
  )
    throw new Error("Invalid approval lifecycle");
  return Object.freeze({
    version: 1,
    serviceId: approvalId(item.serviceId),
    requestId: approvalId(item.requestId),
    source: approvalId(item.source),
    toolCallId: approvalToolCallId(item.toolCallId),
    phase: item.phase as ApprovalPhase,
    ...(item.outcome ? { outcome: item.outcome as ApprovalOutcome } : {}),
  });
}
export function validateQuery(value: unknown): ApprovalQuery {
  const item = record(value);
  keys(item, ["version", "respond"]);
  if (item.version !== 1 || typeof item.respond !== "function") throw new Error("Invalid approval query");
  return value as ApprovalQuery;
}
function validateService(value: unknown): ApprovalService {
  const item = record(value);
  keys(item, ["version", "id", "request"]);
  if (item.version !== 1 || typeof item.request !== "function") throw new Error("Invalid approval service");
  approvalId(item.id);
  return value as ApprovalService;
}
function discover(events: ApprovalEvents): ApprovalService | undefined {
  const peers: ApprovalService[] = [];
  let malformed = false;
  let open = true;
  events.emit(
    APPROVAL_QUERY_CHANNEL,
    Object.freeze({
      version: 1,
      respond: (value: unknown) => {
        if (!open) return;
        try {
          peers.push(validateService(value));
        } catch {
          malformed = true;
        }
      },
    }),
  );
  open = false;
  if (malformed) throw new Error("Malformed approval peer");
  if (peers.length > 1) throw new Error("Duplicate approval services");
  return peers[0];
}
export function assertCurrent(options: ApprovalRequestOptions): void {
  if (
    !options ||
    typeof options.isCurrent !== "function" ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  )
    throw new Error("Invalid approval owner options");
  if (options.signal?.aborted || options.isCurrent() !== true) throw new Error("Approval owner is cancelled or stale");
}
/** Local trusted callbacks, not a wire protocol or a serialization/security boundary. */
export function queryApprovalService(events: ApprovalEvents): ApprovalService | undefined {
  return captureApprovalService(events)?.service;
}
/** A launch may await after approval; retain the SAME peer guard through dispatch. */
export function captureApprovalService(
  events: ApprovalEvents,
): { readonly service: ApprovalService; readonly assertCurrent: () => void } | undefined {
  const peer = discover(events);
  if (!peer) return undefined;
  const id = peer.id;
  const request = peer.request;
  let retired = false;
  const checkPeer = () => {
    if (retired) throw new Error("Captured approval service retired");
    try {
      const current = discover(events);
      if (!current || current !== peer || current.id !== id || current.request !== request)
        throw new Error("Approval service unavailable or replaced");
    } catch (error) {
      retired = true;
      throw error;
    }
  };
  const service: ApprovalService = Object.freeze({
    version: 1,
    id,
    request: async (operation: ApprovalOperation, options: ApprovalRequestOptions) => {
      checkPeer();
      assertCurrent(options);
      const callerCurrent = options.isCurrent;
      const owner = Object.freeze({
        signal: options.signal,
        isCurrent: () => {
          checkPeer();
          return callerCurrent() === true;
        },
      });
      const response = request.call(peer, validateOperation(operation), owner);
      if (!(response instanceof Promise) || (await response) !== undefined) {
        retired = true;
        throw new Error("Invalid approval service response");
      }
      checkPeer();
      assertCurrent(owner);
    },
  });
  return Object.freeze({ service, assertCurrent: checkPeer });
}

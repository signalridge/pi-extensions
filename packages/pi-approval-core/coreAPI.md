# Local approval API v1

```ts
const captured = captureApprovalService(rootPi.events); // capture before first await
// undefined means no approval extension is loaded. The host decides whether ungated
// operation is admissible; do not convert a present-but-failing peer into absence.
const definitions = createApprovalToolDefinitions({
  source: "child:owned-run-id",
  request: (operation, options) => {
    if (!captured) throw new Error("No human approval service");
    return captured.service.request(operation, options);
  },
  isCurrent: (invocationContext) => {
    if (!captured) return false;
    captured.assertCurrent(); // SAME capture, including after post-approval IO
    return callerStillOwns(invocationContext);
  },
  // Optional: isToolCurrent: (ctx, name) => exactBindingAndAdmissionStillCurrent(ctx, name),
});
// SDK: customTools: [...definitions]; do not copy/forward all child UI methods.
```

Reviewed bash additionally requires a POSIX standalone Node.js host with public SEA detection. Bun/compiled Pi, Node SEA and missing/unknown probe capabilities reject before the approval callback or any child process. Imports and factory creation remain resource-free, and edit/write do not invoke this bash-only runtime check. The implementation never probes interpreter compatibility by launching `process.execPath`.

`ApprovalService = { readonly version: 1; readonly id: string; request(operation, options): Promise<void> }`.

`ApprovalRequestOptions = { readonly signal?: AbortSignal; readonly isCurrent: () => boolean }`. This is the caller's **current** ownership predicate, not a saved boolean. False, cancellation, and callback exceptions deny. A captured service never reconnects to another peer after retirement.

`ApprovalOperation` is readonly validated bounded data:

- Common: `source`, `toolName`, `cwd`, `toolCallId`, SHA-256 `inputHash`, full bounded human `preview`.
- `kind: "command"`: `command`; `toolName` is a strict identifier (up to 80 bytes), e.g. `bash` or an explicitly integrated background command tool. The adapter must supply the actual executed command/CWD, not an earlier hook proposal, and generate a truthful escaped preview of all relevant normalized inputs.
- `kind: "write" | "edit"`: canonical matching `toolName`, absolute `filePath`, `before: ApprovalSnapshot | null`, `after: ApprovalSnapshot`. Edit cannot have a missing original. Snapshots contain exact `text`, `bytes`, and SHA-256 `sha256`; all are checked and frozen. Canonical definitions construct these from actual SDK IO.

Kinds are finite; there is no model-callable response/approve tool. Service functions are human-owned trusted peer closures, **not serialized data**. This event bus is not a serialization or security boundary. Source/service/request labels use strict ASCII identifiers of at most 160 UTF-8 bytes. Provider-owned tool-call identifiers instead use `approvalToolCallId`: nonempty valid Unicode, at most 1024 UTF-8 bytes, preserved exactly without truncation or normalization. This accepts OpenAI Responses `call_…|fc_…` and native nested `/n` suffixes. Lifecycle validation uses the same opaque identity parser. Text is valid Unicode and bounded by UTF-8 byte length.

`APPROVAL_QUERY_CHANNEL` is `signalridge:approvals:query:v1`. Query payload: frozen `{ version: 1, respond(service: unknown): void }`. Trusted peers must respond **synchronously**, with exactly `{ version: 1, id, request }`. No peer => undefined. Any malformed peer or more than one response => error, including duplicate responses from the same peer. Captures check object/function/id identity before and after requests and through the ownership callback while pending. Extensions own subscription registration and cleanup.

`captureApprovalService(events)` returns `undefined` on absence, otherwise frozen `{ service, assertCurrent(): void }`. `service` has exactly the existing v1 shape. The synchronous guard checks the same original peer object, ID and request function with the same sticky retirement as requests, without requesting another human decision. An adapter with asynchronous startup after approval must carry this invocation-local guard to its irreversible dispatch boundary; missing, replaced, duplicate or malformed peers deny without reconnecting.

`APPROVAL_LIFECYCLE_CHANNEL` is `signalridge:approvals:lifecycle:v1`. Payload:

```ts
{ version: 1, serviceId, requestId, source, toolCallId,
  phase: "waiting" | "respond" | "resolved",
  outcome?: "approved" | "denied" | "cancelled" | "retired" | "expired" | "error" }
```

Waiting has no outcome; respond/resolved require one. Lifecycle events contain bounded metadata only, never commands, diffs, credentials, or snapshots. `validateLifecycle` checks all fields. A child adapter may pause its owned default tool timeout on matching `source`/`toolCallId` waiting and resume on resolved. Events are observational, not authorization responses; approval time must not be conflated with native command timeout. Alternatively bracket the adapter's awaited request callback, which also covers discovery errors.

## Cooperative command-tool capability

`APPROVAL_ADAPTER_QUERY_CHANNEL` is `signalridge:approvals:adapter:v1`.

```ts
// Query (validated by validateAdapterQuery):
{ version: 1, toolName: string, respond(value: unknown): void }
// Response (validated by validateAdapter):
{ version: 1, toolName: string, parameters: TSchema }
```

`queryApprovalAdapter(events, toolName, effectiveToolInfo.parameters)` requires exactly one **synchronous** valid response with the requested tool name and the **same schema object** as the current effective `ToolInfo.parameters`. None, duplicate, malformed, wrong-name, copied-schema, and asynchronous replies deny. Validators reject extra fields, prototypes, accessors, and unsupported versions. Tool names are strict ASCII tool identifiers, at most 256 UTF-8 bytes.

A cooperating extension registers its own listener **after** registering its command tools. It responds only for schemas it owns while its context and effective binding remain live. Advertising this capability attests that the tool gates its final native command/CWD through the human service; it is not an authorization grant. The library registers no listeners. Source labels or names alone never establish capability. This is a trusted-extension integration boundary, not an OS sandbox. Older adapters without this protocol are blocked by the approvals extension for command-shaped calls.

`requiresApprovalAdapter(input)` recognizes an own `command`, or `path` plus `content`/`edits`/known old/new-text properties, at the root or one `input` envelope. `schemaRequiresApprovalAdapter(parameters)` also recognizes those known own properties in the schema's root `properties` or one `input.properties`, even when optional. Neither evaluates arbitrary semantics or expands schema references/compositions. This conservative pre-invocation classification prevents known optional normalizer inputs bypassing a root policy without a public post-handler boundary. Managed hosts should additionally recheck actual mutable native arguments after downstream handlers using the originally captured execution name and effective schema.

File factory review generation requires at most 2,048 combined `beforeText.split("\n").length + afterText.split("\n").length` tokens before synchronous diffing; missing before text is empty. Files/inputs remain 256 KiB and completed reviews 64 KiB. No partial review is approved.

The service/request/factory/lifecycle API remains v1, with no added required fields. Root native-backend certification is a separate human CLI policy, not a model-callable permission and not required by factories constructed by a host that knows their backend.

The extension requests no automatic UI: humans use `/approvals` while a tool is paused. Child SDK sessions have no UI by default. Hosts integrating the captured root service should exclude a separately inherited approval extension to avoid shadowing/headless double gates. Preserve stronger admission/Plan restrictions before injecting customTools. No managed-subagent protocol changes or child/background adapter implementations are part of this library.

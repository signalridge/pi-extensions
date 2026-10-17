import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionToolContext,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import {
  APPROVAL_ADAPTER_QUERY_CHANNEL,
  APPROVAL_QUERY_CHANNEL,
  type ApprovalOperation,
  approvalToolCallId,
  captureApprovalService,
  createApprovalBashOperations,
  createApprovalToolDefinitions,
  escapeDisplay,
  hashBytes,
  queryApprovalAdapter,
  queryApprovalService,
  schemaRequiresApprovalAdapter,
  snapshot,
  validateAdapterQuery,
  validateLifecycle,
  validateOperation,
  validateQuery,
} from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture(request: (operation: ApprovalOperation) => Promise<void>, isCurrent = () => true) {
  expect(VERSION).toBe("1.0.4");
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "approval-core-")));
  let context: ExtensionContext | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        pi.on("session_start", (_event, ctx) => {
          context = ctx;
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    tools: [],
  });
  await session.bindExtensions({ mode: "print" });
  cleanup.push(async () => {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  if (!context) throw new Error("Missing real SDK context");
  const ctx: ExtensionToolContext = {
    ...context,
    tools: [],
    executeTool: async () => {
      throw new Error("Unused direct context nested execution");
    },
  };
  const [edit, write, bash] = createApprovalToolDefinitions({ source: "test", request, isCurrent });
  return { cwd, ctx, edit, write, bash };
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const command: ApprovalOperation = validateOperation({
  source: "test",
  kind: "command",
  toolName: "bash",
  cwd: "/test",
  toolCallId: "t1",
  command: "true",
  preview: "true",
  inputHash: hashBytes("true"),
});

it("discovers exactly one validated synchronous peer, absent/malformed/duplicate peers fail closed", async () => {
  const events = createEventBus();
  expect(queryApprovalService(events)).toBeUndefined();
  const peer = Object.freeze({ version: 1 as const, id: "service", request: vi.fn(async () => {}) });
  const off = events.on(APPROVAL_QUERY_CHANNEL, (data) => validateQuery(data).respond(peer));
  const captured = queryApprovalService(events);
  expect(captured?.id).toBe("service");
  await captured?.request(command, { isCurrent: () => true });
  expect(peer.request).toHaveBeenCalledOnce();
  const duplicate = events.on(APPROVAL_QUERY_CHANNEL, (data) => validateQuery(data).respond(peer));
  expect(() => queryApprovalService(events)).toThrow("Duplicate");
  duplicate();
  off();
  await expect(captured?.request(command, { isCurrent: () => true })).rejects.toThrow();
  events.on(APPROVAL_QUERY_CHANNEL, (data) => validateQuery(data).respond(peer));
  await expect(captured?.request(command, { isCurrent: () => true })).rejects.toThrow("retired");
  events.clear();
  events.on(APPROVAL_QUERY_CHANNEL, (data) => validateQuery(data).respond({ version: 4 }));
  expect(() => queryApprovalService(events)).toThrow("Malformed");
});
it("ignores asynchronous query replies and rejects malformed request return values", async () => {
  const events = createEventBus();
  events.on(APPROVAL_QUERY_CHANNEL, (value) => {
    const query = validateQuery(value);
    queueMicrotask(() => query.respond({ version: 1, id: "late", request: async () => {} }));
  });
  expect(queryApprovalService(events)).toBeUndefined();
  await Promise.resolve();
  events.clear();
  const malformed = { version: 1, id: "bad", request: () => true };
  events.on(APPROVAL_QUERY_CHANNEL, (value) => validateQuery(value).respond(malformed));
  const captured = queryApprovalService(events);
  await expect(captured?.request(command, { isCurrent: () => true })).rejects.toThrow("response");
  await expect(captured?.request(command, { isCurrent: () => true })).rejects.toThrow("retired");
});
it("validates hashes, kinds, strict fields, sizes and unicode without echoing input", () => {
  expect(() => validateOperation({ ...command, source: "bad\x1bsource" })).toThrow();
  expect(() => validateOperation({ ...command, preview: "x".repeat(65537) })).toThrow();
  expect(() => validateOperation({ ...command, command: "\ud800" })).toThrow();
  expect(() => validateOperation({ ...command, credential: "SECRET" })).toThrow("Unknown approval field");
  expect(() => snapshot(Buffer.from([0xff]))).toThrow("UTF-8");
  expect(() => snapshot(Buffer.from([0]))).toThrow("Binary");
  expect(escapeDisplay("\x1b\u202e\ufeff\r\t\\")).toBe("\\u{1b}\\u{202e}\\u{feff}\\u{d}\\u{9}\\\\");
});
it("uses exact SDK BOM/CRLF/fuzzy/batched original edit output", async () => {
  const seen: ApprovalOperation[] = [];
  const host = await fixture(async (operation) => {
    seen.push(operation);
  });
  const path = join(host.cwd, "text");
  await writeFile(path, "\ufeffhello ‘world’  \r\nsecond\r\nthird\r\n");
  await host.edit.execute(
    "edit1",
    {
      path,
      edits: [
        { oldText: "hello 'world'", newText: "new" },
        { oldText: "third", newText: "last" },
      ],
    },
    undefined,
    undefined,
    host.ctx,
  );
  expect(await readFile(path, "utf8")).toBe("\ufeffnew\r\nsecond\r\nlast\r\n");
  expect(seen[0]).toMatchObject({ kind: "edit", after: { text: "\ufeffnew\r\nsecond\r\nlast\r\n" } });
  expect(seen[0].preview).toContain("\\u{feff}");
  expect(seen[0].preview).toContain("\\u{d}");
  await expect(
    host.edit.execute(
      "edit2",
      {
        path,
        edits: [
          { oldText: "new", newText: "a" },
          { oldText: "new", newText: "b" },
        ],
      },
      undefined,
      undefined,
      host.ctx,
    ),
  ).rejects.toThrow();
  expect(seen).toHaveLength(1);
});
it("serializes same paths within the SDK queue without an outer queued deadlock", async () => {
  const gates = [deferred(), deferred()];
  const seen: ApprovalOperation[] = [];
  const host = await fixture(async (operation) => {
    const index = seen.push(operation) - 1;
    await gates[index].promise;
  });
  const path = join(host.cwd, "text");
  await writeFile(path, "start");
  const first = host.write.execute("first", { path, content: "one" }, undefined, undefined, host.ctx);
  const second = host.write.execute("second", { path, content: "two" }, undefined, undefined, host.ctx);
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(await readFile(path, "utf8")).toBe("start");
  gates[0].resolve();
  await first;
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  expect(seen[1]).toMatchObject({ before: { text: "one" } });
  gates[1].resolve();
  await second;
  expect(await readFile(path, "utf8")).toBe("two");
});
it("different files reach two independent human gates concurrently", async () => {
  const gates = [deferred(), deferred()];
  const seen: ApprovalOperation[] = [];
  const host = await fixture(async (operation) => {
    seen.push(operation);
    await gates[operation.toolCallId === "a" ? 0 : 1].promise;
  });
  const a = host.write.execute("a", { path: "a", content: "a" }, undefined, undefined, host.ctx);
  const b = host.write.execute("b", { path: "b", content: "b" }, undefined, undefined, host.ctx);
  await vi.waitFor(() => expect(seen).toHaveLength(2));
  gates[0].resolve();
  await a;
  await expect(readFile(join(host.cwd, "b"))).rejects.toThrow();
  gates[1].resolve();
  await b;
});
it.each(["change", "creation", "disappearance", "symlink"])("denies external %s during review", async (mode) => {
  let host: Awaited<ReturnType<typeof fixture>>;
  host = await fixture(async (operation) => {
    if (operation.kind === "command") throw new Error("wrong kind");
    if (mode === "change" || mode === "creation") await writeFile(operation.filePath, "external");
    if (mode === "disappearance") await unlink(operation.filePath);
    if (mode === "symlink") {
      await unlink(operation.filePath);
      await writeFile(join(host.cwd, "other"), "other");
      await symlink(join(host.cwd, "other"), operation.filePath);
    }
  });
  const path = join(host.cwd, "text");
  if (mode !== "creation") await writeFile(path, "before");
  await expect(
    host.write.execute("external", { path, content: "after" }, undefined, undefined, host.ctx),
  ).rejects.toThrow();
  if (mode === "change" || mode === "creation") expect(await readFile(path, "utf8")).toBe("external");
});
it("denial creates no directories and leaves file queues usable", async () => {
  let deny = true;
  const host = await fixture(async () => {
    if (deny) throw new Error("denied");
  });
  await expect(
    host.write.execute("denied", { path: "new/dir/text", content: "after" }, undefined, undefined, host.ctx),
  ).rejects.toThrow("denied");
  await expect(readFile(join(host.cwd, "new"))).rejects.toThrow();
  deny = false;
  await host.write.execute("approved", { path: "new/dir/text", content: "after" }, undefined, undefined, host.ctx);
  expect(await readFile(join(host.cwd, "new/dir/text"), "utf8")).toBe("after");
});
it("cancelled calls waiting on a file queue never approve or block a later write", async () => {
  const gate = deferred();
  let count = 0;
  const host = await fixture(async () => {
    count++;
    if (count === 1) await gate.promise;
  });
  const first = host.write.execute("first", { path: "file", content: "1" }, undefined, undefined, host.ctx);
  await vi.waitFor(() => expect(count).toBe(1));
  const abort = new AbortController();
  const second = host.write.execute("cancelled", { path: "file", content: "2" }, abort.signal, undefined, host.ctx);
  const rejection = expect(second).rejects.toThrow("aborted");
  abort.abort();
  const third = host.write.execute("third", { path: "file", content: "3" }, undefined, undefined, host.ctx);
  gate.resolve();
  await first;
  await rejection;
  await third;
  expect(count).toBe(2);
  expect(await readFile(join(host.cwd, "file"), "utf8")).toBe("3");
});
it("clones final args synchronously, refuses late schema corruption and binds actual bash command", async () => {
  const gate = deferred();
  const seen: ApprovalOperation[] = [];
  const host = await fixture(async (operation) => {
    seen.push(operation);
    await gate.promise;
  });
  const params = { path: "file", content: "reviewed" };
  const call = host.write.execute("clone", params, undefined, undefined, host.ctx);
  params.content = "mutated during IO";
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  expect(seen[0]).toMatchObject({ after: { text: "reviewed" } });
  gate.resolve();
  await call;
  expect(await readFile(join(host.cwd, "file"), "utf8")).toBe("reviewed");
  const invalid = JSON.parse('{"path":42,"content":"secret"}');
  await expect(host.write.execute("bad", invalid, undefined, undefined, host.ctx)).rejects.toThrow("schema");
  const commandInput = { command: "printf reviewed; printf err >&2" };
  const bash = host.bash.execute("bash", commandInput, undefined, undefined, host.ctx);
  commandInput.command = "false";
  const result = await bash;
  expect(seen[1]).toMatchObject({ command: "printf reviewed; printf err >&2", cwd: host.cwd });
  expect(result.content).toMatchObject([{ text: "reviewederr" }]);
});
it("rejects invalid UTF8 and oversized generated reviews rather than approving clipped changes", async () => {
  const request = vi.fn(async () => {});
  const host = await fixture(request);
  const path = join(host.cwd, "file");
  await writeFile(path, Buffer.from([0xff]));
  await expect(host.write.execute("binary", { path, content: "safe" }, undefined, undefined, host.ctx)).rejects.toThrow(
    "UTF-8",
  );
  await unlink(path);
  await expect(
    host.write.execute("large", { path, content: "x".repeat(70000) }, undefined, undefined, host.ctx),
  ).rejects.toThrow("review");
  expect(request).not.toHaveBeenCalled();
});
it("callback errors and cancellation after a human gate deny before native IO", async () => {
  const abort = new AbortController();
  const host = await fixture(async () => {
    abort.abort();
  });
  await expect(
    host.write.execute("abort", { path: "file", content: "secret" }, abort.signal, undefined, host.ctx),
  ).rejects.toThrow();
  await expect(readFile(join(host.cwd, "file"))).rejects.toThrow();
  const stale = await fixture(
    async () => {},
    () => {
      throw new Error("stale callback");
    },
  );
  await expect(
    stale.bash.execute("stale", { command: "touch marker" }, undefined, undefined, stale.ctx),
  ).rejects.toThrow("stale callback");
  await expect(readFile(join(stale.cwd, "marker"))).rejects.toThrow();
});
it("honestly leaves approved directories after owner failure following mkdir", async () => {
  let host: Awaited<ReturnType<typeof fixture>> | undefined;
  host = await fixture(
    async () => {},
    () => !host || !existsSync(join(host.cwd, "created")),
  );
  await expect(
    host.write.execute("mkdir-failure", { path: "created/file", content: "reviewed" }, undefined, undefined, host.ctx),
  ).rejects.toThrow("stale");
  expect(existsSync(join(host.cwd, "created"))).toBe(true);
  expect(existsSync(join(host.cwd, "created/file"))).toBe(false);
});
it("preserves native bash timeout, cancellation, exit errors and output truncation", async () => {
  const host = await fixture(async () => {});
  await expect(
    host.bash.execute("timeout", { command: "sleep 5", timeout: 0.01 }, undefined, undefined, host.ctx),
  ).rejects.toThrow("timed out");
  const result = await host.bash.execute(
    "failure",
    { command: "printf failure; exit 7" },
    undefined,
    undefined,
    host.ctx,
  );
  expect(result).toMatchObject({ isError: true, structuredContent: { exit_code: 7 } });
  const abort = new AbortController();
  const running = host.bash.execute("cancel", { command: "sleep 5" }, abort.signal, undefined, host.ctx);
  const rejected = expect(running).rejects.toThrow("aborted");
  setTimeout(() => abort.abort(), 20);
  await rejected;
  const truncated = await host.bash.execute(
    "truncated",
    { command: "printf '%060000d' 1" },
    undefined,
    undefined,
    host.ctx,
  );
  expect(truncated.details?.truncation?.truncated).toBe(true);
  if (truncated.details?.fullOutputPath) await rm(truncated.details.fullOutputPath, { force: true });
});

it("opaque provider/nested identities are unchanged, bounded valid Unicode while service identities stay strict", () => {
  for (const id of ["call_abc|fc_def", "call_abc|fc_def/1/2", "工具/请求|nested", "x".repeat(1024)]) {
    expect(approvalToolCallId(id)).toBe(id);
    expect(validateOperation({ ...command, toolCallId: id }).toolCallId).toBe(id);
    expect(
      validateLifecycle({
        version: 1,
        serviceId: "service",
        requestId: "request",
        source: "source",
        toolCallId: id,
        phase: "waiting",
      }).toolCallId,
    ).toBe(id);
  }
  for (const id of ["", "x".repeat(1025), "界".repeat(342), "\ud800"]) expect(() => approvalToolCallId(id)).toThrow();
  expect(() => validateOperation({ ...command, source: "call|source" })).toThrow();
});
it("lifecycle enum validation requires primitive strings without invoking coercion", () => {
  const base = {
    version: 1,
    serviceId: "service",
    requestId: "request",
    source: "source",
    toolCallId: "call_abc|fc_def",
    phase: "resolved",
    outcome: "approved",
  };
  const phase = vi.fn(() => "resolved");
  const outcome = vi.fn(() => "approved");
  for (const invalid of [
    { ...base, phase: { toString: phase } },
    { ...base, phase: ["resolved"] },
    { ...base, outcome: { toString: outcome } },
    { ...base, outcome: ["approved"] },
  ])
    expect(() => validateLifecycle(invalid)).toThrow("lifecycle");
  expect(phase).not.toHaveBeenCalled();
  expect(outcome).not.toHaveBeenCalled();
  for (const currentPhase of ["respond", "resolved"]) {
    for (const currentOutcome of ["approved", "denied", "cancelled", "retired", "expired", "error"])
      expect(validateLifecycle({ ...base, phase: currentPhase, outcome: currentOutcome })).toMatchObject({
        phase: currentPhase,
        outcome: currentOutcome,
      });
  }
  expect(validateLifecycle({ ...base, phase: "waiting", outcome: undefined })).toMatchObject({ phase: "waiting" });
});
it("approval validators reject prototypes and accessors without invoking them", () => {
  let invoked = false;
  expect(() => validateOperation(Object.create(command))).toThrow("prototype");
  expect(() =>
    validateQuery({
      version: 1,
      get respond() {
        invoked = true;
        return () => {};
      },
    }),
  ).toThrow("accessor");
  expect(invoked).toBe(false);
  expect(() => validateAdapterQuery(Object.create({ version: 1, toolName: "bash_background", respond() {} }))).toThrow(
    "prototype",
  );
});
it("adapter discovery validates exact field/version/name/schema identity and one synchronous reply", async () => {
  const events = createEventBus();
  const parameters = Type.Object({ command: Type.String() });
  const adapter = Object.freeze({ version: 1, toolName: "bash_background", parameters });
  const response = (value: unknown) =>
    events.on(APPROVAL_ADAPTER_QUERY_CHANNEL, (query) => validateAdapterQuery(query).respond(value));
  expect(() => queryApprovalAdapter(events, adapter.toolName, parameters)).toThrow();
  let off = response(adapter);
  expect(queryApprovalAdapter(events, adapter.toolName, parameters)).toBe(adapter);
  const duplicate = response(adapter);
  expect(() => queryApprovalAdapter(events, adapter.toolName, parameters)).toThrow();
  duplicate();
  off();
  for (const invalid of [
    { ...adapter, version: 2 },
    { ...adapter, toolName: "other" },
    { ...adapter, extra: true },
    { ...adapter, parameters: structuredClone(parameters) },
    { ...adapter, parameters: null },
  ]) {
    off = response(invalid);
    expect(() => queryApprovalAdapter(events, adapter.toolName, parameters)).toThrow();
    off();
  }
  off = events.on(APPROVAL_ADAPTER_QUERY_CHANNEL, (value) => {
    const query = validateAdapterQuery(value);
    queueMicrotask(() => query.respond(adapter));
  });
  expect(() => queryApprovalAdapter(events, adapter.toolName, parameters)).toThrow();
  await Promise.resolve();
  off();
});

it("rejects 50k disjoint lines before synchronous diff work or approval", async () => {
  // A Vitest testTimeout cannot interrupt synchronous JS. Own a separate
  // process with a thread pool so SIGKILL also reclaims its blocked worker.
  if (process.env.PI_APPROVAL_DIFF_CHILD !== "1") {
    const probe = await mkdtemp(join(tmpdir(), "approval-diff-deadline-"));
    cleanup.push(() => rm(probe, { recursive: true, force: true }));
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const cli = fileURLToPath(new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")));
    const child = spawn(
      process.execPath,
      [cli, "run", "test/core.test.ts", "-t", "rejects 50k disjoint", "--pool=threads", "--maxWorkers=1"],
      {
        cwd,
        env: { ...process.env, TMPDIR: probe, TMP: probe, TEMP: probe, PI_APPROVAL_DIFF_CHILD: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4096);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      expect(await closed, output).toEqual({ code: 0, signal: null });
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
    return;
  }
  const request = vi.fn(async () => {});
  const host = await fixture(request);
  const path = join(host.cwd, "many-lines");
  const before = "a\n".repeat(50_000);
  await writeFile(path, before);
  await expect(
    host.write.execute("disjoint", { path, content: "b\n".repeat(50_000) }, undefined, undefined, host.ctx),
  ).rejects.toThrow("review computational limit");
  expect(request).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe(before);
}, 8000);

it.each(["options", "env-only", "captured-abort"])(
  "captures bash execution options and env before awaiting review (%s)",
  async (mode) => {
    const gate = deferred();
    const host = await fixture(async () => {});
    const controller = new AbortController();
    const replacement = new AbortController();
    const env = { ...process.env, APPROVAL_CAPTURE: "reviewed" };
    let output = "";
    const execution = {
      signal: controller.signal,
      timeout: 2,
      env,
      onData: (data: Buffer) => {
        output += data.toString();
      },
    };
    const ops = createApprovalBashOperations({
      source: "test",
      toolCallId: "capture",
      inputHash: hashBytes("input"),
      request: async () => gate.promise,
      isCurrent: () => true,
    });
    const running = ops.exec("printf '%s' \"$APPROVAL_CAPTURE\"", host.cwd, execution);
    if (mode !== "env-only") execution.signal = replacement.signal;
    if (mode !== "env-only") execution.timeout = 0.00001;
    execution.env = { ...env, APPROVAL_CAPTURE: "replaced" };
    env.APPROVAL_CAPTURE = "mutated";
    if (mode !== "env-only")
      execution.onData = () => {
        throw new Error("mutated callback");
      };
    if (mode === "captured-abort") controller.abort();
    else replacement.abort();
    const result = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    gate.resolve();
    if (mode === "captured-abort") expect(await result).toBeInstanceOf(Error);
    else {
      expect(await result).toBeUndefined();
      expect(output).toBe("reviewed");
    }
  },
);

it("keeps useful large files below the line-work budget and reviews complete changes", async () => {
  const request = vi.fn(async () => {});
  const host = await fixture(request);
  const path = join(host.cwd, "large-normal");
  const before = Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(1000)}`).join("\n");
  const after = before.replace("100 ", "changed ");
  await writeFile(path, before);
  await host.write.execute("normal", { path, content: after }, undefined, undefined, host.ctx);
  expect(request).toHaveBeenCalledOnce();
  expect(await readFile(path, "utf8")).toBe(after);
});

it("exposes a sticky same-peer guard without making a second human request", async () => {
  const events = createEventBus();
  const request = vi.fn(async () => {});
  const peer = { version: 1, id: "service", request };
  let current = peer;
  events.on(APPROVAL_QUERY_CHANNEL, (value) => validateQuery(value).respond(current));
  const captured = captureApprovalService(events);
  if (!captured) throw new Error("Missing service");
  await captured.service.request(command, { isCurrent: () => true });
  captured.assertCurrent();
  expect(request).toHaveBeenCalledOnce();
  current = { ...peer };
  expect(() => captured.assertCurrent()).toThrow("replaced");
  current = peer;
  expect(() => captured.assertCurrent()).toThrow("retired");
  expect(request).toHaveBeenCalledOnce();
});

it("classifies known optional root/enveloped schema properties without evaluating accessors", () => {
  for (const schema of [
    Type.Object({ command: Type.Optional(Type.String()) }),
    Type.Object({ path: Type.String(), content: Type.Optional(Type.String()) }),
    Type.Object({ input: Type.Object({ command: Type.Optional(Type.String()) }) }),
  ])
    expect(schemaRequiresApprovalAdapter(schema)).toBe(true);
  expect(schemaRequiresApprovalAdapter(Type.Object({ title: Type.String() }))).toBe(false);
  const getter = vi.fn();
  const schema = Type.Object({ title: Type.String() });
  Object.defineProperty(schema, "properties", { get: getter });
  expect(schemaRequiresApprovalAdapter(schema)).toBe(false);
  expect(getter).not.toHaveBeenCalled();
});

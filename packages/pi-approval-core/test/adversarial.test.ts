import childProcess, { spawn } from "node:child_process";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionToolContext,
  initTheme,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import {
  APPROVAL_QUERY_CHANNEL,
  captureApprovalService,
  createApprovalBashOperations,
  createApprovalToolDefinitions,
  hashBytes,
  queryApprovalService,
  validateQuery,
} from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const f of cleanup.splice(0).reverse()) await f();
});
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "approval-adversarial-")));
  let context: ExtensionContext | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
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
  cleanup.push(async () => {
    session.dispose();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "print" });
  if (!context) throw new Error("Missing SDK context");
  const ctx: ExtensionToolContext = {
    ...context,
    tools: [],
    executeTool: async () => {
      throw new Error("Unused nested execution");
    },
  };
  return { cwd, session, ctx };
}
it("A: deadline-isolated 40k disjoint edit render never reads or diffs", async () => {
  if (process.env.APPROVAL_RENDER_PROBE !== "1") {
    const probe = await fs.mkdtemp(join(tmpdir(), "approval-render-deadline-"));
    cleanup.push(() => fs.rm(probe, { recursive: true, force: true }));
    const cli = fileURLToPath(new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")));
    const child = spawn(
      process.execPath,
      [cli, "run", "test/adversarial.test.ts", "-t", "A: deadline", "--pool=threads", "--maxWorkers=1"],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: { ...process.env, TMPDIR: probe, TMP: probe, TEMP: probe, APPROVAL_RENDER_PROBE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (b) => {
      output = (output + b).slice(-4096);
    });
    child.stderr.on("data", (b) => {
      output = (output + b).slice(-4096);
    });
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      expect(await closed, output).toEqual({ code: 0, signal: null });
    } finally {
      clearTimeout(deadline);
    }
    return;
  }
  const { cwd, session } = await fixture();
  const path = join(cwd, "render-target");
  await fs.writeFile(path, "a\n".repeat(40000));
  const read = vi.spyOn(syncFs, "readFileSync");
  syncBuiltinESMExports();
  const [edit] = createApprovalToolDefinitions({ source: "test", request: async () => {}, isCurrent: () => true });
  const args = { path, edits: [{ oldText: "a\n".repeat(40000), newText: "b\n".repeat(40000) }] };
  initTheme("dark", false);
  const theme = session.extensionRunner.getUIContext().theme;
  const readAsync = vi.spyOn(fs, "readFile");
  syncBuiltinESMExports();
  const component = edit.renderCall?.(args, theme, {
    args,
    toolCallId: "render",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd,
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
  });
  expect(component).toBeDefined();
  expect(read.mock.calls.some((call) => call[0] === path)).toBe(false);
  for (const width of [0, 1, 4, 40, 80])
    expect(component?.render(width)).toEqual(["edit (human approval required)".slice(0, width)]);
  await new Promise((r) => setImmediate(r));
  expect(readAsync).not.toHaveBeenCalled();
}, 8000);
it.each(["ownership", "service"])("B: held cwd access blocks dispatch after %s invalidation", async (loss) => {
  const { cwd } = await fixture();
  const entered = gate(),
    release = gate();
  const access = fs.access;
  vi.spyOn(fs, "access").mockImplementation(async (...args) => {
    if (args[0] === cwd) {
      entered.resolve();
      await release.promise;
    }
    return access(...args);
  });
  const dispatched = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  let current = true;
  const events = createEventBus();
  const request = vi.fn(async () => {});
  const peer = { version: 1, id: "peer", request };
  const off = events.on(APPROVAL_QUERY_CHANNEL, (v) => validateQuery(v).respond(peer));
  const captured = captureApprovalService(events);
  if (!captured) throw new Error("Missing peer");
  const ops = createApprovalBashOperations({
    source: "test",
    toolCallId: "dispatch",
    inputHash: hashBytes("cmd"),
    request: captured.service.request,
    isCurrent: () => {
      captured.assertCurrent();
      return current;
    },
  });
  const running = ops.exec("printf unsafe > marker", cwd, { onData() {} }).then(
    () => "executed",
    () => "denied",
  );
  await entered.promise;
  if (loss === "service") off();
  else current = false;
  release.resolve();
  expect(await running).toBe("denied");
  expect(syncFs.existsSync(join(cwd, "marker"))).toBe(false);
  expect(request).toHaveBeenCalledOnce();
  expect(dispatched).not.toHaveBeenCalled();
});
it.each(["retired", "replaced"])(
  "C: documented generic factory keeps its same-peer guard during held recheck (%s)",
  async (loss) => {
    const { cwd, ctx } = await fixture();
    const events = createEventBus();
    let approved = false;
    const request = vi.fn(async () => {
      approved = true;
    });
    let peer = { version: 1, id: "peer", request };
    const off = events.on(APPROVAL_QUERY_CHANNEL, (v) => validateQuery(v).respond(peer));
    const doc = await fs.readFile(fileURLToPath(new URL("../coreAPI.md", import.meta.url)), "utf8");
    const snippet = doc.split("```ts\n")[1]?.split("```")[0];
    if (!snippet) throw new Error("Missing example");
    let options: Parameters<typeof createApprovalToolDefinitions>[0] | undefined;
    new Function(
      "captureApprovalService",
      "queryApprovalService",
      "rootPi",
      "createApprovalToolDefinitions",
      "callerStillOwns",
      snippet,
    )(
      captureApprovalService,
      queryApprovalService,
      { events },
      (value: typeof options) => {
        options = value;
        return [];
      },
      () => true,
    );
    if (!options) throw new Error("Missing factory options");
    const [, write] = createApprovalToolDefinitions(options);
    const entered = gate(),
      release = gate();
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (approved) {
        entered.resolve();
        await release.promise;
      }
      return lstat(...args);
    });
    syncBuiltinESMExports();
    const running = write
      .execute("doc", { path: "doc-new/dir/file", content: "never" }, undefined, undefined, ctx)
      .then(
        () => "executed",
        () => "denied",
      );
    await entered.promise;
    if (loss === "retired") off();
    else peer = { ...peer };
    release.resolve();
    expect(await running).toBe("denied");
    expect(syncFs.existsSync(join(cwd, "doc-new"))).toBe(false);
    expect(() => options?.isCurrent(ctx)).toThrow(/unavailable|replaced|retired/);
    expect(request).toHaveBeenCalledOnce();
  },
);
it.each(["edit", "write", "bash"] as const)(
  "D: exact-name invocation guard denies %s after review without another request",
  async (name) => {
    const { cwd, ctx } = await fixture();
    let admitted = true;
    const request = vi.fn(async () => {
      admitted = false;
    });
    const admission = vi.fn((_ctx: ExtensionToolContext, actual: string) => {
      expect(actual).toBe(name);
      return admitted;
    });
    const [edit, write, bash] = createApprovalToolDefinitions({
      source: "test",
      isCurrent: () => true,
      isToolCurrent: admission,
      request,
      commandPrefix: "export PREFIX=reviewed",
    });
    await fs.writeFile(join(cwd, "existing"), "before");
    const running =
      name === "edit"
        ? edit.execute(
            "admission",
            { path: "existing", edits: [{ oldText: "before", newText: "after" }] },
            undefined,
            undefined,
            ctx,
          )
        : name === "write"
          ? write.execute("admission", { path: "admission/file", content: "never" }, undefined, undefined, ctx)
          : bash.execute("admission", { command: "printf '%s' \"$PREFIX\" > marker" }, undefined, undefined, ctx);
    await expect(running).rejects.toThrow(/stale|cancelled/);
    expect(await fs.readFile(join(cwd, "existing"), "utf8")).toBe("before");
    expect(syncFs.existsSync(join(cwd, "admission"))).toBe(false);
    expect(syncFs.existsSync(join(cwd, "marker"))).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    expect(admission.mock.calls.length).toBeGreaterThan(1);
  },
);
it("B: SDK factory prefixes the exact reviewed command without replacing output behavior", async () => {
  const { ctx, cwd } = await fixture();
  const request = vi.fn(async () => {});
  const [, , bash] = createApprovalToolDefinitions({
    source: "test",
    isCurrent: () => true,
    request,
    commandPrefix: "export PREFIX=reviewed",
  });
  const result = await bash.execute("prefix", { command: "printf '%s' \"$PREFIX\"" }, undefined, undefined, ctx);
  expect(result.structuredContent).toMatchObject({ output: "reviewed", exit_code: 0 });
  expect(request.mock.calls[0]).toMatchObject([
    { command: "export PREFIX=reviewed\nprintf '%s' \"$PREFIX\"", cwd },
    expect.anything(),
  ]);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(new URL("..", import.meta.url).pathname);
const packagesRoot = join(root, "packages");

function packageDirs() {
  return readdirSync(packagesRoot)
    .filter((name) => statSync(join(packagesRoot, name)).isDirectory())
    .sort();
}

function extensionDirs() {
  return packageDirs().filter((directory) => {
    const manifest = JSON.parse(readFileSync(join(packagesRoot, directory, "package.json"), "utf8"));
    return manifest.signalridgePackage?.kind !== "library";
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function pack(directory, destination) {
  const result = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: join(packagesRoot, directory),
  });
  const info = JSON.parse(result.stdout.trim())[0];
  assert.equal(info.name, `@signalridge/${directory}`);
  const tarball = join(destination, info.filename);
  assert.ok(existsSync(tarball), `npm pack did not produce ${tarball}`);
  return tarball;
}

/**
 * Where a dependency's code actually lives for the smoke run.
 *
 * The workspace checkout is a candidate, not just the two `node_modules` trees,
 * because a sibling package is not always installed into them. A package may
 * declare a peer range that the workspace does not satisfy *yet* — `pi-workflows`
 * requires `pi-subagents` `>=1.9.0` while the checkout still reads 1.8.1, which
 * is exactly what the pending release fixes — and an unsatisfiable peer is
 * skipped rather than linked. That window is one release long and says nothing
 * about whether the extension loads, which is all this smoke test measures.
 * Declared ranges are checked by check-shared-dep-ranges and check-versions.
 *
 * Note this cannot mask a genuinely missing dependency: only a package that
 * exists in `packages/` is resolved here, and an external one still throws.
 */
function linkDependency(consumerNodeModules, dependency, fallbackRoot) {
  const workspaceDirectory = localPackageDirectories().get(dependency);
  const candidates = [
    join(root, "node_modules", dependency),
    join(fallbackRoot, "node_modules", dependency),
    ...(workspaceDirectory ? [join(packagesRoot, workspaceDirectory)] : []),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) throw new Error(`smoke dependency is not installed: ${dependency}`);
  const target = join(consumerNodeModules, dependency);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) return;
  symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}

function linkDeclaredDependencies(packageRoot, manifest, fallbackRoot) {
  const destination = join(packageRoot, "node_modules");
  for (const dependency of new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])) {
    linkDependency(destination, dependency, fallbackRoot);
  }
}

function localPackageDirectories() {
  return new Map(
    packageDirs().map((directory) => {
      const manifest = JSON.parse(readFileSync(join(packagesRoot, directory, "package.json"), "utf8"));
      return [manifest.name, directory];
    }),
  );
}

function extractPackedDependencies(packageTemp, manifest, tarballs) {
  const localDirectories = localPackageDirectories();
  const roots = new Map();
  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  for (const dependency of dependencies) {
    const directory = localDirectories.get(dependency);
    const tarball = directory === undefined ? undefined : tarballs.get(directory);
    if (!directory || !tarball) continue;
    const extracted = join(packageTemp, "packed-dependencies", directory);
    if (!existsSync(join(extracted, "package"))) {
      mkdirSync(extracted, { recursive: true });
      run("tar", ["-xzf", tarball, "-C", extracted]);
    }
    roots.set(dependency, join(extracted, "package"));
  }
  return roots;
}

function linkPackedDependencies(packageRoot, manifest, roots) {
  for (const dependency of new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])) {
    const source = roots.get(dependency);
    if (!source) continue;
    const target = join(packageRoot, "node_modules", dependency);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  }
}

async function activatePackage(
  packageRoot,
  manifest,
  consumer,
  agentDir,
  fallbackRoot,
  packedDependencyRoots = new Map(),
) {
  linkPackedDependencies(packageRoot, manifest, packedDependencyRoots);
  const options = manifest.name === "@signalridge/pi-github-pr" ? { keepSession: true } : {};
  return activateRoots(
    [packageRoot],
    consumer,
    agentDir,
    manifest.pi.extensions.length,
    manifest.name,
    [fallbackRoot],
    options,
  );
}

async function activateRoots(
  roots,
  consumer,
  agentDir,
  expectedResourceCount,
  label,
  fallbackRoots = [],
  options = {},
) {
  const manifests = roots.map((packageRoot, index) => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    linkDeclaredDependencies(packageRoot, manifest, fallbackRoots[index] ?? dirname(packageRoot));
    return manifest;
  });
  const settingsManager = SettingsManager.create(consumer, agentDir);
  const packageManager = new DefaultPackageManager({ cwd: consumer, agentDir, settingsManager });
  const resolved = await packageManager.resolveExtensionSources(roots, { temporary: true });
  assert.equal(
    resolved.extensions.length,
    expectedResourceCount,
    `${label} package manager resolved an unexpected number of extension resources`,
  );
  const resourcePaths = resolved.extensions.map((resource) => resource.path);
  const extensionPaths = [...resourcePaths, ...(options.extensionPaths ?? [])];
  const expectedLoadedResourceCount = expectedResourceCount + (options.extensionPaths?.length ?? 0);
  assert.equal(new Set(extensionPaths).size, extensionPaths.length, `${label} resolved duplicate extension resources`);

  const loader = new DefaultResourceLoader({
    cwd: consumer,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loadedExtensions = loader.getExtensions();
  assert.equal(
    loadedExtensions.extensions.length,
    expectedLoadedResourceCount,
    `${label} loader discovered an unexpected number of extensions`,
  );
  assert.equal(
    loadedExtensions.errors.length,
    0,
    `${label} resource errors: ${loadedExtensions.errors.map((error) => error.error).join("; ")}`,
  );

  const errors = [];
  const { session } = await createAgentSession({
    cwd: consumer,
    agentDir,
    settingsManager,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(consumer),
    ...(options.model ? { model: options.model } : {}),
    ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
    resourceLoader: loader,
    // Keep built-in tools disabled to avoid model/tool execution, but retain
    // extension tools so coexistence checks are meaningful.
    noTools: "builtin",
  });
  if (options.beforeBind) await options.beforeBind(session);
  await session.bindExtensions({ onError: (error) => errors.push(String(error)) });
  const names = session.getAllTools().map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, `${label} registered duplicate tools`);
  assert.equal(errors.length, 0, `${label} activation errors: ${errors.join("; ")}`);
  // AgentSession 0.84 exposes tools but not commands. If a future public
  // session API provides command discovery, enforce the same uniqueness gate;
  // never reach into Pi's private ExtensionRunner just for this smoke.
  const commandDiscovery = session;
  if (typeof commandDiscovery.getCommands === "function") {
    const commands = commandDiscovery.getCommands();
    const commandNames = commands.map((command) => command.name);
    assert.equal(new Set(commandNames).size, commandNames.length, `${label} registered duplicate commands`);
  }
  if (!options.keepSession) session.dispose();
  return {
    resourceCount: loadedExtensions.extensions.length,
    toolCount: names.length,
    errors,
    manifests,
    session: options.keepSession ? session : undefined,
  };
}

function toolText(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

async function waitFor(check, label, timeoutMs = 5_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createFlakySessionManager(cwd, failures = 2) {
  const sessionManager = SessionManager.inMemory(cwd);
  const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
  const state = { remaining: failures };
  sessionManager.appendCustomEntry = (customType, data) => {
    if (
      customType === "pi-workflows:journal" &&
      state.remaining > 0 &&
      (data?.kind === "call_result" || data?.kind === "call_attempt")
    ) {
      state.remaining -= 1;
      throw new Error("transient smoke journal failure");
    }
    return appendCustomEntry(customType, data);
  };
  return { sessionManager, state };
}

function seedInterruptedWorkflow(session) {
  const runId = "real-pi-recovery";
  const script = `export const meta = { name: "recovery smoke", description: "Recover one call" };
const recovered = await agent("Return the recovered result.", { label: "recover" });
return recovered;`;
  const nodeId = "0";
  const attemptId = `${runId}/${nodeId}/attempt-1`;
  const owner = { extension: "pi-workflows", runId, nodeId, attemptId };
  let timestamp = Date.now();
  const append = (event) => session.sessionManager.appendCustomEntry("pi-workflows:journal", event);
  append({
    kind: "run_created",
    schemaVersion: 4,
    runId,
    script,
    scriptHash: "smoke-recovery-script-hash",
    meta: { name: "recovery smoke", description: "Recover one call" },
    frozenArgsPresent: false,
    attempts: { [nodeId]: 1 },
    attemptIds: { [nodeId]: attemptId },
    timestamp: timestamp++,
  });
  append({ kind: "workflow_transition", schemaVersion: 4, runId, status: "running", timestamp: timestamp++ });
  append({
    kind: "call_attempt",
    schemaVersion: 4,
    runId,
    nodeId,
    attemptId,
    generation: 1,
    owner,
    timestamp: timestamp++,
  });
  append({
    kind: "call_transition",
    schemaVersion: 4,
    runId,
    nodeId,
    status: "running",
    agentId: "old-agent",
    attemptId,
    owner,
    timestamp,
  });
}

async function runRealPiWorkflowIntegration(session, faux) {
  const workflow = session.getToolDefinition("workflow");
  const control = session.getToolDefinition("workflow_control");
  assert.ok(workflow, "Pi did not expose workflow through AgentSession");
  assert.ok(control, "Pi did not expose workflow_control through AgentSession");
  const emitEvent = session.getToolDefinition("smoke_emit_event");
  assert.ok(emitEvent, "Pi did not expose the event-bus fixture tool");

  let activeResponses = 0;
  let maxActiveResponses = 0;
  const response = (text) => async () => {
    activeResponses += 1;
    maxActiveResponses = Math.max(maxActiveResponses, activeResponses);
    await new Promise((resolve) => setTimeout(resolve, 25));
    activeResponses -= 1;
    return fauxAssistantMessage(text);
  };
  const isolatedResponse = async (context) => {
    assert.ok(
      context.systemPrompt?.includes("real-pi-isolated-agent-marker"),
      "custom isolated agent configuration was not loaded",
    );
    return response("isolated task")();
  };
  faux.setResponses([
    response("task A"),
    response("task B"),
    response("task C"),
    isolatedResponse,
    response("synthesis output"),
  ]);
  const dagScript = `export const meta = { name: "real Pi DAG", description: "Integration DAG" };
const results = await parallel([
  () => agent("Return A.", { label: "a" }),
  () => agent("Return B.", { label: "b" }),
]);
const c = await agent("Return C.", { label: "c" });
const isolated = await agent("Return isolated.", { label: "isolated", agentType: "isolated" });
return "synthesis output";`;
  const completed = await workflow.execute(
    "real-dag",
    {
      script: dagScript,
      background: false,
    },
    undefined,
    undefined,
    undefined,
  );
  assert.match(toolText(completed), /status=completed/);
  assert.match(toolText(completed), /synthesis output/);
  const completedRunId = completed.details?.runId;
  assert.ok(maxActiveResponses >= 2, `DAG did not dispatch independent tasks concurrently (max=${maxActiveResponses})`);
  assert.equal(typeof completedRunId, "string");

  const listed = await control.execute("real-list", { action: "list" }, undefined, undefined, undefined);
  assert.ok(toolText(listed).includes(completedRunId));
  const entriesAfterDag = session.sessionManager.getBranch();
  assert.ok(entriesAfterDag.some((entry) => entry.type === "custom" && entry.customType === "pi-workflows:journal"));
  assert.ok(entriesAfterDag.some((entry) => entry.type === "custom" && entry.customType === "subagents:managed-spawn"));
  assert.ok(
    entriesAfterDag.some(
      (entry) =>
        entry.type === "custom" && entry.customType === "subagents:managed-spawn" && entry.data?.type === "isolated",
    ),
  );
  assert.ok(
    entriesAfterDag.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "subagents:managed-spawn" &&
        typeof entry.data?.owner?.nodeId === "string" &&
        entry.data?.owner?.nodeId?.startsWith("call-"),
    ),
  );

  // Force a real managed queue with the temporary maxConcurrent=2 setting and
  // ensure every queued response drains instead of being lost at the terminal
  // boundary.
  let queuedActive = 0;
  let queuedMaxActive = 0;
  let queuedStarts = 0;
  const queuedResponse = (text) => async () => {
    queuedStarts += 1;
    queuedActive += 1;
    queuedMaxActive = Math.max(queuedMaxActive, queuedActive);
    await new Promise((resolve) => setTimeout(resolve, 30));
    queuedActive -= 1;
    return fauxAssistantMessage(text);
  };
  faux.setResponses([queuedResponse("queue 1"), queuedResponse("queue 2"), queuedResponse("queue 3")]);
  const queueScript = `export const meta = { name: "real Pi queue", description: "Queue" };
await parallel(Array.from({ length: 3 }, (_, i) => () => agent("Return queue " + (i + 1) + ".", { label: "q" + (i + 1) })));
return 0;`;
  const queued = await workflow.execute(
    "real-queue",
    {
      script: queueScript,
      background: false,
    },
    undefined,
    undefined,
    undefined,
  );
  assert.match(toolText(queued), /status=completed/);
  assert.equal(queuedStarts, 3);
  assert.equal(queuedMaxActive, 2, "real Pi queue did not enforce maxConcurrent");

  // Exercise Pi's public tree navigation. The workflow and subagent lifecycle
  // handlers must suspend/rebind without losing their event-bus context.
  const treeRoot = session.sessionManager.appendCustomEntry("real-pi:tree-root", {});
  session.sessionManager.appendCustomEntry("real-pi:tree-child", {});
  await session.navigateTree(treeRoot, { summarize: false });
  const afterTree = await control.execute("real-tree-list", { action: "list" }, undefined, undefined, undefined);
  assert.ok(toolText(afterTree).includes(completedRunId));

  // Start a second background run and stop it through workflow_control. The
  // faux response continues resolving after cancellation, exercising owned
  // quiescence and stale-result quarantine on a real Pi event bus.
  let slowSettled = false;
  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      slowSettled = true;
      return fauxAssistantMessage("slow result");
    },
  ]);
  const slowCallTarget = faux.state.callCount + 1;
  const slowScript = `export const meta = { name: "real Pi stop", description: "Stop" };
await agent("Return slowly.", { label: "slow" });
return 0;`;
  const background = await workflow.execute(
    "real-stop",
    {
      script: slowScript,
      background: true,
    },
    undefined,
    undefined,
    undefined,
  );
  const stopRunId = background.details?.runId;
  assert.equal(typeof stopRunId, "string");
  await waitFor(() => faux.state.callCount >= slowCallTarget, "managed faux task dispatch");
  const active = await control.execute(
    "real-stop-get",
    { action: "get", run_id: stopRunId },
    undefined,
    undefined,
    undefined,
  );
  const activeRun = active.details?.run;
  const activeManaged = [...session.sessionManager.getBranch()]
    .reverse()
    .find(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "subagents:managed-spawn" &&
        entry.data?.owner?.runId === stopRunId &&
        entry.data?.owner?.nodeId === "call-0" &&
        entry.data?.state === "running",
    );
  const activeAgentId = activeManaged?.data?.id ?? activeRun?.calls?.find((call) => call.index === 0)?.agentId;
  const activeAttemptId = activeManaged?.data?.owner?.attemptId;
  assert.equal(typeof activeAgentId, "string");
  assert.equal(typeof activeAttemptId, "string");
  await emitEvent.execute(
    "stale-event",
    {
      channel: "subagents:completed",
      data: {
        id: activeAgentId,
        owner: { extension: "pi-workflows", runId: stopRunId, nodeId: "call-0", attemptId: "stale-attempt" },
        result: "stale completion",
      },
    },
    undefined,
    undefined,
    undefined,
  );
  const afterStale = await control.execute(
    "real-stop-after-stale",
    { action: "get", run_id: stopRunId },
    undefined,
    undefined,
    undefined,
  );
  assert.notEqual(afterStale.details?.run?.status, "completed");
  const stopped = await control.execute(
    "real-stop-control",
    { action: "stop", run_id: stopRunId },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(stopped.details?.run?.status, "stopped");
  await waitFor(() => slowSettled, "late faux provider settlement");
  const afterLate = await control.execute(
    "real-stop-after-late",
    { action: "get", run_id: stopRunId },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(afterLate.details?.run?.status, "stopped");
}

const temp = mkdtempSync(join(tmpdir(), "pi-independent-package-smoke-"));
const previousHome = process.env.HOME;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = join(temp, "home");
process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
try {
  const tarballs = new Map();
  for (const directory of packageDirs()) tarballs.set(directory, pack(directory, temp));

  const reports = [];
  for (const directory of extensionDirs()) {
    const packageTemp = mkdtempSync(join(temp, `${directory}-`));
    try {
      run("tar", ["-xzf", tarballs.get(directory), "-C", packageTemp]);
      const packageRoot = join(packageTemp, "package");
      const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      const consumer = join(packageTemp, "consumer");
      const agentDir = join(packageTemp, "agent");
      mkdirSync(consumer, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      const packedDependencyRoots = extractPackedDependencies(packageTemp, manifest, tarballs);
      const report = await activatePackage(
        packageRoot,
        manifest,
        consumer,
        agentDir,
        join(packagesRoot, directory),
        packedDependencyRoots,
      );
      reports.push({ directory, ...report });
      console.log(`smoke: ${manifest.name} (${report.resourceCount} resource, ${report.toolCount} tools)`);
      // Independent sessions are intentionally created in one Node process. Pi's
      // extension lifecycle normally clears this singleton on shutdown, but the
      // loader smoke disposes an in-memory session directly; clear the fixture's
      // process-global manager before the next package can claim root ownership.
      if (manifest.name === "@signalridge/pi-subagents") {
        delete globalThis[Symbol.for("pi-subagents:manager")];
        delete globalThis[Symbol.for("pi-subagents:rpc-owner")];
        delete globalThis[Symbol.for("pi-subagents:manager-active")];
      }
    } finally {
      rmSync(packageTemp, { recursive: true, force: true });
    }
  }

  // The two protocol peers must also activate together through package-manager
  // resource resolution. This catches duplicate registration and ordering bugs
  // without loading monorepo source paths or a root aggregate manifest.
  const stablePairTemp = mkdtempSync(join(temp, "stable-pair-"));
  try {
    const roots = [];
    const fallbackRoots = [];
    const packedDependencyRoots = new Map();
    const protocolDirectory = "pi-subagents-protocol";
    const protocolExtracted = join(stablePairTemp, "packed-dependencies", protocolDirectory);
    mkdirSync(protocolExtracted, { recursive: true });
    run("tar", ["-xzf", tarballs.get(protocolDirectory), "-C", protocolExtracted]);
    packedDependencyRoots.set("@signalridge/pi-subagents-protocol", join(protocolExtracted, "package"));
    for (const directory of ["pi-subagents", "pi-workflows"]) {
      const extracted = join(stablePairTemp, directory);
      mkdirSync(extracted, { recursive: true });
      run("tar", ["-xzf", tarballs.get(directory), "-C", extracted]);
      const packageRoot = join(extracted, "package");
      const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      linkPackedDependencies(packageRoot, manifest, packedDependencyRoots);
      roots.push(packageRoot);
      fallbackRoots.push(join(packagesRoot, directory));
    }
    const consumer = join(stablePairTemp, "consumer");
    const agentDir = join(stablePairTemp, "agent");
    mkdirSync(consumer, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(consumer, ".pi"), { recursive: true });
    writeFileSync(
      join(consumer, ".pi", "subagents.json"),
      JSON.stringify({
        maxConcurrent: 2,
        schedulingEnabled: false,
        agentTiers: {
          defaultTier: "medium",
          profiles: {
            low: { model: "inherit", thinking: "inherit" },
            medium: { model: "inherit", thinking: "inherit" },
            high: { model: "inherit", thinking: "inherit" },
          },
        },
      }),
    );
    mkdirSync(join(consumer, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(consumer, ".pi", "agents", "isolated.md"),
      "---\ndescription: Real Pi worktree isolation smoke\nisolation: worktree\n---\nreal-pi-isolated-agent-marker\n",
    );
    writeFileSync(join(consumer, "README.md"), "real Pi workflow smoke\n");
    run("git", ["init", "--quiet"], { cwd: consumer });
    run("git", ["config", "user.email", "smoke@example.invalid"], { cwd: consumer });
    run("git", ["config", "user.name", "Pi smoke"], { cwd: consumer });
    run("git", ["add", "."], { cwd: consumer });
    run("git", ["commit", "--quiet", "-m", "initial smoke fixture"], { cwd: consumer });
    const eventFixture = join(stablePairTemp, "smoke-events.mjs");
    writeFileSync(
      eventFixture,
      `export default function smokeEvents(pi) {
  pi.registerTool({
    name: "smoke_emit_event",
    label: "Emit smoke event",
    description: "Emit a Pi event-bus payload for lifecycle quarantine tests.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", minLength: 1 },
        data: { type: "object", additionalProperties: true },
      },
      required: ["channel", "data"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      pi.events.emit(params.channel, params.data);
      return { content: [{ type: "text", text: "event emitted" }] };
    },
  });
}
`,
    );

    // Use Pi's built-in faux provider so this is a real 0.84.1 AgentSession and
    // event bus test without credentials or network access.
    const faux = fauxProvider({
      provider: "signalridge-pi-smoke",
      models: [{ id: "smoke-model", name: "Signalridge smoke", reasoning: false }],
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const previousCwd = process.cwd();
    process.chdir(consumer);
    const flaky = createFlakySessionManager(consumer, 2);
    try {
      const pair = await activateRoots(
        roots,
        consumer,
        agentDir,
        2,
        "stable pi-subagents + pi-workflows",
        fallbackRoots,
        {
          keepSession: true,
          model: faux.getModel(),
          modelRuntime,
          extensionPaths: [eventFixture],
          sessionManager: flaky.sessionManager,
        },
      );
      console.log(`smoke: stable pi-subagents + pi-workflows ordering (${pair.toolCount} tools)`);
      await runRealPiWorkflowIntegration(pair.session, faux);
      assert.equal(flaky.state.remaining, 0, "journal retry fixture was not exercised");
      pair.session.dispose();
      delete globalThis[Symbol.for("pi-subagents:manager")];
      delete globalThis[Symbol.for("pi-subagents:rpc-owner")];
      delete globalThis[Symbol.for("pi-subagents:manager-active")];

      // Re-open the same independently packaged pair with a seeded active
      // journal branch. Pi's real session_start recovery must rotate it to an
      // interrupted attempt, and workflow_control resume must dispatch it over
      // the same event bus.
      faux.setResponses([fauxAssistantMessage("recovered result")]);
      const recoveryPair = await activateRoots(
        roots,
        consumer,
        agentDir,
        2,
        "stable pi-subagents + pi-workflows recovery",
        fallbackRoots,
        {
          keepSession: true,
          model: faux.getModel(),
          modelRuntime,
          extensionPaths: [eventFixture],
          beforeBind: seedInterruptedWorkflow,
        },
      );
      const recoveryControl = recoveryPair.session.getToolDefinition("workflow_control");
      assert.ok(recoveryControl, "Pi did not expose recovery workflow_control");
      const recovered = await recoveryControl.execute(
        "recovery-get",
        { action: "get", run_id: "real-pi-recovery" },
        undefined,
        undefined,
        undefined,
      );
      assert.equal(recovered.details?.run?.status, "interrupted");
      await recoveryControl.execute(
        "recovery-resume",
        { action: "resume", run_id: "real-pi-recovery" },
        undefined,
        undefined,
        undefined,
      );
      let recoveryStatus;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await recoveryControl.execute(
          "recovery-poll",
          { action: "get", run_id: "real-pi-recovery" },
          undefined,
          undefined,
          undefined,
        );
        recoveryStatus = current.details?.run?.status;
        if (recoveryStatus === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(recoveryStatus, "completed");
      recoveryPair.session.dispose();
      delete globalThis[Symbol.for("pi-subagents:manager")];
      delete globalThis[Symbol.for("pi-subagents:rpc-owner")];
      delete globalThis[Symbol.for("pi-subagents:manager-active")];
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    rmSync(stablePairTemp, { recursive: true, force: true });
  }

  // All stable packages must coexist in one isolated Pi resource loader. This
  // is intentionally a tarball-only activation: it catches package `files`
  // omissions and duplicate public tool names without using a root manifest or
  // the live settings directory.
  const stableDirectories = packageDirs().filter((directory) => {
    const manifest = JSON.parse(readFileSync(join(packagesRoot, directory, "package.json"), "utf8"));
    return manifest.signalridgePackage?.kind !== "library" && manifest.piExtension?.lifecycle === "stable";
  });
  const stableAllTemp = mkdtempSync(join(temp, "stable-all-"));
  try {
    const roots = [];
    const fallbackRoots = [];
    let expectedResources = 0;
    for (const directory of stableDirectories) {
      const extracted = join(stableAllTemp, directory);
      mkdirSync(extracted, { recursive: true });
      run("tar", ["-xzf", tarballs.get(directory), "-C", extracted]);
      const packageRoot = join(extracted, "package");
      const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      roots.push(packageRoot);
      fallbackRoots.push(join(packagesRoot, directory));
      expectedResources += manifest.pi.extensions.length;
    }
    const consumer = join(stableAllTemp, "consumer");
    const agentDir = join(stableAllTemp, "agent");
    mkdirSync(consumer, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const allStable = await activateRoots(
      roots,
      consumer,
      agentDir,
      expectedResources,
      `all stable packages (${stableDirectories.length})`,
      fallbackRoots,
      { keepSession: true },
    );
    console.log(
      `smoke: all stable packages (${stableDirectories.length} packages, ${allStable.resourceCount} resources, ${allStable.toolCount} tools)`,
    );
  } finally {
    rmSync(stableAllTemp, { recursive: true, force: true });
  }

  assert.equal(reports.length, extensionDirs().length, "not every extension package was independently activated");
  console.log(
    `smoke-pi-loaders: activated ${reports.length} independent package tarballs, the stable pair, and ${stableDirectories.length} stable packages together`,
  );
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(temp, { recursive: true, force: true });
}

// Pi 0.84's public AgentSession.dispose invalidates extension contexts but does
// not emit session_shutdown; terminate only after every smoke assertion and
// cleanup above so extension-owned unref timers cannot outlive the temp tree.
process.exit(0);

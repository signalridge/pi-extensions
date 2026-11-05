import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { assertExactHost, assertPerimeter, qualifySessionSchemas } from "./pi-schema-qualification.mjs";

assertExactHost();
assertPerimeter();
const scope = process.argv[2];
assert.ok(["stable", "explicit-all"].includes(scope), "experimental qualification requires explicit-all");
const root = resolve(new URL("..", import.meta.url).pathname);
const packages = readdirSync(join(root, "packages"))
  .sort()
  .flatMap((directory) => {
    const path = join(root, "packages", directory);
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    return manifest.pi?.extensions?.length && (scope === "explicit-all" || manifest.piExtension?.lifecycle === "stable")
      ? [{ path, name: manifest.name }]
      : [];
  });
assert.ok(packages.length > 0);
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const faux = fauxProvider({ provider: "source-schema-qualification", models: [{ id: "offline", reasoning: false }] });
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  modelsStorePath: join(cwd, "models.json"),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
runtime.registerNativeProvider(faux.provider);
const settingsManager = SettingsManager.inMemory({
  defaultTools: [],
  compaction: { enabled: false },
  retry: { enabled: false },
  cacheWarming: "off",
});
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths: packages.map(({ path }) => path),
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert.deepEqual(loader.getExtensions().warnings ?? [], []);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model: faux.getModel(),
  thinkingLevel: "off",
  modelRuntime: runtime,
  settingsManager,
  sessionManager: SessionManager.inMemory(cwd),
  resourceLoader: loader,
  tools: [],
});
const errors = [];
try {
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(String(error)) });
  qualifySessionSchemas(session, `source ${scope} (${packages.length} packages)`, { requireSamples: true });
  assert.deepEqual(errors, []);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.deepEqual(errors, []);
  assert.equal(faux.state.callCount, 0, "source qualification never executes model requests");
  assertPerimeter();
} finally {
  session.dispose();
}
// Dispose does not own extension timers; all shutdown hooks have now completed.
process.exit(0);

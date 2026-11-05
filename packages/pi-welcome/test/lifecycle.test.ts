import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type EntryRenderer,
  type EntryRenderOptions,
  type ExtensionAPI,
  type ExtensionContext,
  keyHint,
  keyText,
  SessionManager,
  type Settings,
  SettingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import welcome, { collectHints, collectResources } from "../src/index.js";

const renderOptions: EntryRenderOptions = { expanded: false, keyText, keyHint };

type Data = { rows: [string, string][]; hints?: string[] };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const facts: Data = {
  rows: [
    ["Directory", "original workspace"],
    ["Branch", "original branch"],
    ["Model", "original model"],
    ["Budget", "original budget"],
    ["Skills", "stale-skill"],
  ],
};

function harness(manager = SessionManager.inMemory(), settings: Settings = {}) {
  let start: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  let renderer: EntryRenderer<Data> | undefined;
  const pi = {
    registerEntryRenderer: (_name: string, callback: EntryRenderer<Data>) => {
      renderer = callback;
    },
    on: (_event: string, callback: typeof start) => {
      start = callback;
    },
    appendEntry: (name: string, data: Data) => manager.appendCustomEntry(name, data),
    getSessionName: () => "new session",
    getCommands: () => [],
    getSettings: () => settings,
  };
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    sessionManager: manager,
    isProjectTrusted: () => true,
    model: { provider: "provider", id: "model", contextWindow: 100000 },
    ui: { getAllThemes: () => [{ name: "project-theme" }, { name: "package-theme" }] },
  } as unknown as ExtensionContext;
  welcome(pi as unknown as ExtensionAPI);
  return {
    manager,
    ctx,
    start: () => start?.({}, ctx),
    render: (options = renderOptions, width = 160) => {
      const entry = manager
        .buildContextEntries()
        .find((entry) => entry.type === "custom" && entry.customType === "welcome-card");
      assert.ok(entry?.type === "custom");
      return (
        renderer?.(entry as Parameters<EntryRenderer<Data>>[0], options, theme)
          ?.render(width)
          .join("\n") ?? ""
      );
    },
  };
}

test("resumed cards use host-injected remapped and unbound hints without changing stored facts", async () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("welcome-card", { ...facts, hints: ["obsolete interrupt"] });
  const h = harness(manager);
  await h.start();
  const before = JSON.stringify(manager.getEntries());
  const keys = new KeybindingsManager(
    {
      "app.interrupt": { defaultKeys: "escape" },
      "app.clear": { defaultKeys: "ctrl+c" },
      "app.tools.expand": { defaultKeys: "ctrl+o" },
    },
    {
      "app.interrupt": ["ctrl+x", "ctrl+z"],
      "app.clear": [],
      "app.tools.expand": "ctrl+e",
    },
  );
  const options: EntryRenderOptions = {
    expanded: false,
    keyText: (id) => keys.getKeys(id).join("/"),
    keyHint: () => {
      throw new Error("card styling must use the supplied theme, not styled hints");
    },
  };
  assert.deepEqual(collectHints(options), ["Ctrl+X/Ctrl+Z interrupt", "/ commands", "! bash", "Ctrl+E expand tools"]);
  assert.ok(Array.isArray(collectHints()), "no-argument API is preserved");
  assert.match(h.render(options), /Ctrl\+X\/Ctrl\+Z interrupt/);
  assert.match(h.render(options), /Ctrl\+E expand tools/);
  assert.doesNotMatch(h.render(options), /obsolete|clear/);
  assert.match(h.render(options), /original workspace/);
  // The same host formatter can see new bindings on the next renderer call.
  keys.setUserBindings({ "app.interrupt": "ctrl+b", "app.clear": [], "app.tools.expand": [] });
  assert.match(h.render(options), /Ctrl\+B interrupt/);
  assert.doesNotMatch(h.render(options), /Ctrl\+X|expand tools|clear/);
  assert.match(h.render(options, 19), /Ctrl\+B interrupt/);
  keys.setUserBindings({ "app.interrupt": [], "app.clear": [], "app.tools.expand": [] });
  assert.match(h.render(options), /\/ commands · ! bash/);
  assert.doesNotMatch(h.render(options), /interrupt|expand tools|clear/);
  assert.equal(JSON.stringify(manager.getEntries()), before);
});

test("a normal resume/reload does not duplicate a visible welcome card", async () => {
  const h = harness();
  await h.start();
  await h.start();
  assert.equal(h.manager.getEntries().filter((entry) => entry.type === "custom").length, 1);
});

test("compacted resume restores the active branch's original workspace facts", async () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("welcome-card", facts);
  const kept = manager.appendMessage({ role: "user", content: "keep", timestamp: Date.now() });
  manager.appendCompaction("summary", kept, 2000);
  const h = harness(manager);
  assert.equal(
    manager.buildContextEntries().some((entry) => entry.type === "custom"),
    false,
  );
  await h.start();
  assert.match(h.render(), /original workspace/);
  assert.match(h.render(), /original branch/);
  assert.match(h.render(), /original model/);
  assert.match(h.render(), /original budget/);
  assert.doesNotMatch(h.render(), /stale-skill/);
  const count = manager.getEntries().length;
  await h.start();
  assert.equal(manager.getEntries().length, count);
});

test("off-branch welcome cards do not suppress a card or lend their facts on reload", async () => {
  const manager = SessionManager.inMemory();
  const fork = manager.appendMessage({ role: "user", content: "fork", timestamp: Date.now() });
  manager.appendCustomEntry("welcome-card", facts);
  manager.branch(fork);
  manager.appendMessage({ role: "user", content: "active", timestamp: Date.now() });
  const h = harness(manager);
  await h.start();
  assert.doesNotMatch(h.render(), /original workspace|original branch|original model|original budget/);
  assert.match(h.render(), /new session/);
  const count = manager.getEntries().length;
  await h.start();
  assert.equal(manager.getEntries().length, count);
});

test("budget follows effective project/model settings, defaults, zero, disabling, and validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-welcome-settings-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        compaction: { reserveTokens: 10000, modelOverrides: { "provider/model": { reserveTokens: 25000 } } },
      }),
    );
    writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ compaction: { reserveTokens: 20000 } }));
    const merged = SettingsManager.create(root, agentDir).getSettings();
    const cases: [Settings, string][] = [
      [{}, "compacts at 84K"],
      [{ compaction: { reserveTokens: 20000 } }, "compacts at 80K"],
      [merged, "compacts at 75K"],
      [
        { compaction: { reserveTokens: 10000, modelOverrides: { "provider/model": { reserveTokens: 0 } } } },
        "compacts at 100K",
      ],
      [{ compaction: { reserveTokens: 0 } }, "compacts at 100K"],
      [{ compaction: { enabled: false, reserveTokens: 20000 } }, ""],
      [{ compaction: { reserveTokens: -1 } }, ""],
      [{ compaction: { reserveTokens: 1.5 } }, ""],
      [{ compaction: { reserveTokens: -1, modelOverrides: { "provider/model": { reserveTokens: 20000 } } } }, ""],
      [{ compaction: { modelOverrides: { "provider/model": { reserveTokens: -1 } } } }, ""],
    ];
    for (const [settings, suffix] of cases) {
      const h = harness(SessionManager.inMemory(), settings);
      await h.start();
      if (suffix) assert.ok(h.render().includes(suffix), h.render());
      else assert.doesNotMatch(h.render(), /compacts at/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory uses trust-resolved settings and describes packages rather than loaded extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-welcome-trust-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    mkdirSync(join(root, ".pi"));
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [
          "npm:@scope/pi-global",
          { source: "npm:@scope/pi-skills-only", autoload: false, extensions: [], skills: ["./skills"] },
          { source: "npm:@scope/pi-disabled", autoload: false, extensions: [] },
        ],
      }),
    );
    writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({ packages: ["npm:@scope/pi-untrusted"] }));
    const settings = SettingsManager.create(root, agentDir, { projectTrusted: false });
    const pi = { getSettings: () => settings.getSettings(), getCommands: () => [] } as unknown as ExtensionAPI;
    const rows = new Map(
      collectResources(pi, root, {
        getAllThemes: () => [{ name: "package-theme" }, { name: "project-theme" }],
      } as never),
    );
    assert.equal(rows.get("Configured packages"), "global, skills-only");
    assert.equal(rows.has("Extensions"), false);
    assert.equal(rows.get("Available themes"), "package-theme, project-theme");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default autoload exclusion-only filters retain package inventory while empty and opt-in filters disable it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-welcome-autoload-"));
  try {
    const packageRoot = join(root, "pi-filtered");
    const agentDir = join(root, "agent");
    mkdirSync(packageRoot);
    mkdirSync(agentDir);
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "pi-filtered",
        type: "module",
        pi: { extensions: ["index.ts", "excluded.ts"] },
      }),
    );
    writeFileSync(join(packageRoot, "index.ts"), "export default function index() {}\n");
    writeFileSync(join(packageRoot, "excluded.ts"), "export default function excluded() {}\n");
    for (const [autoload, extensions, expected] of [
      [undefined, ["!excluded.ts"], 1],
      [true, ["!excluded.ts"], 1],
      [undefined, ["-excluded.ts"], 1],
      [false, ["!excluded.ts"], 0],
      [false, ["-excluded.ts"], 0],
      [undefined, [], 0],
      [false, [], 0],
    ] as const) {
      const settingsManager = SettingsManager.inMemory({
        packages: [
          {
            source: packageRoot,
            ...(autoload === undefined ? {} : { autoload }),
            extensions: [...extensions],
            skills: [],
            prompts: [],
            themes: [],
          },
        ],
      });
      const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noContextFiles: true });
      await loader.reload();
      assert.equal(loader.getExtensions().errors.length, 0);
      assert.equal(loader.getExtensions().extensions.length, expected, "installed host filter semantics");
      const rows = new Map(
        collectResources({ getSettings: () => settingsManager.getSettings() } as ExtensionAPI, root),
      );
      assert.equal(rows.get("Configured packages"), expected ? "filtered" : undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual host resources_discover skills/prompts appear in the post-bind renderer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-welcome-bind-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const skillDir = join(root, "discovered-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: discovered-skill\ndescription: Discovered after session_start\n---\nInstructions\n",
    );
    const prompt = join(root, "discovered-prompt.md");
    writeFileSync(prompt, "---\ndescription: Discovered prompt\n---\nPrompt\n");
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      extensionFactories: [
        welcome,
        (pi) => {
          pi.on("resources_discover", () => ({ skillPaths: [skillDir], promptPaths: [prompt] }));
        },
      ],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(root);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      sessionManager: manager,
      resourceLoader: loader,
      noTools: true,
    });
    try {
      await session.bindExtensions({
        mode: "tui",
        uiContext: { getAllThemes: () => [{ name: "package-theme", path: undefined }] } as never,
      });
      const entry = manager
        .buildContextEntries()
        .find((entry) => entry.type === "custom" && entry.customType === "welcome-card");
      assert.ok(entry?.type === "custom");
      assert.equal(
        (entry.data as Data).rows.some(([label]) => label === "Skills" || label === "Prompts"),
        false,
      );
      const renderer = session.extensionRunner.getEntryRenderer("welcome-card");
      const text = renderer?.(entry, renderOptions, theme)?.render(160).join("\n") ?? "";
      assert.match(text, /Inventory:\s+live at render/);
      assert.match(text, /Skills:\s+discovered-skill/);
      assert.match(text, /Prompts:\s+\/discovered-prompt/);
      assert.match(text, /Available themes:\s+package-theme/);
      assert.equal((entry.data as Data).hints, undefined, "new entries persist facts, not bindings");
      const injected: EntryRenderOptions = {
        expanded: false,
        keyText: (id) => (id === "app.interrupt" ? "ctrl+j" : ""),
        keyHint: () => "unused styled hint",
      };
      const remapped = renderer?.(entry, injected, theme)?.render(160).join("\n") ?? "";
      assert.match(remapped, /Ctrl\+J interrupt/);
      assert.doesNotMatch(remapped, /clear|expand tools|unused styled hint/);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const peers = ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"];

function withOwnedSandbox<T>(run: (sandbox: string) => T): T {
  const ownedSandbox = mkdtempSync(join(tmpdir(), "pi-goal-compact-child-"));
  try {
    return run(realpathSync(ownedSandbox));
  } finally {
    rmSync(ownedSandbox, { recursive: true, force: true });
  }
}

function runComposition(
  options: {
    host?: string;
    dependenciesRoot?: string;
    writeConfig?: (path: string, content: string) => void;
    onSandbox?: (sandbox: string) => void;
  } = {},
): void {
  withOwnedSandbox((sandbox) => {
    options.onSandbox?.(sandbox);
    let dependencies = options.dependenciesRoot ?? root;
    while (!existsSync(join(dependencies, "node_modules/@earendil-works/pi-ai/package.json"))) {
      const parent = dirname(dependencies);
      assert.notEqual(parent, dependencies, "existing dependencies required; this test never installs");
      dependencies = parent;
    }
    const require = createRequire(join(dependencies, "package.json"));
    // Optional offline host qualification: all four peers always come from one
    // root, never a mixed installed/baseline runtime. No dependency is modified.
    const host = options.host ?? process.env.PI_COMPACT_TEST_HOST;
    const peerRoot = host ?? join(dependencies, "node_modules/@earendil-works");
    const versions = peers.map(
      (name) => JSON.parse(readFileSync(join(peerRoot, name, "package.json"), "utf8")).version as string,
    );
    assert.equal(new Set(versions).size, 1, "qualification must use four consistent host peers");
    const aliases = [
      { find: "@signalridge/pi-ui", replacement: join(root, "packages/pi-ui/src/index.ts") },
      {
        find: "@narumitw/pi-tui-kit",
        replacement: join(dependencies, "packages/pi-codex-compact/node_modules/@narumitw/pi-tui-kit/dist/index.js"),
      },
      ...peers.map((name) => ({
        find: `@earendil-works/${name}`,
        replacement: join(peerRoot, name, "dist"),
      })),
    ];
    // Directory aliases also resolve public provider subpath imports.
    const permissions = [
      "--permission",
      `--allow-fs-read=${dependencies}`,
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${sandbox}`,
      ...(host ? [`--allow-fs-read=${dirname(host)}`] : []),
      `--allow-fs-write=${sandbox}`,
      "--allow-worker",
      "--allow-addons",
    ];
    const config = join(sandbox, "vitest.config.mjs");
    (options.writeConfig ?? writeFileSync)(
      config,
      `export default ${JSON.stringify({
        root,
        cacheDir: join(sandbox, "cache"),
        resolve: { alias: aliases },
        test: {
          include: ["scripts/goal-compaction-composition.fixture.ts"],
          setupFiles: ["scripts/goal-compaction.setup.ts"],
          environment: "node",
          execArgv: permissions,
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 20_000,
          hookTimeout: 20_000,
          server: { deps: { inline: true } },
        },
      })}`,
    );
    const args = [
      ...permissions,
      join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
      "run",
      "--config",
      config,
      "--pool=threads",
      "--reporter=verbose",
    ];
    const child = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: sandbox,
        TMPDIR: sandbox,
        XDG_CACHE_HOME: sandbox,
        PI_CODING_AGENT_DIR: sandbox,
        PI_COMPACT_SANDBOX: sandbox,
        NO_COLOR: "1",
      },
    });
    const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    assert.equal(child.error, undefined, output);
    assert.equal(child.status, 0, output);
    assert.match(output, /Test Files\s+1 passed \(1\)/, output);
    assert.match(output, /Tests\s+19 passed \(19\)/, output);
    console.log(`Offline host peers: ${versions.join(", ")}\n${output}`);
  });
}

// No SDK/extension imports in this parent. Start a restricted child with its
// synthetic home/agent dir already set, before even SDK module evaluation.
test("Goal + Compact offline native automatic-compaction composition (restricted child)", () => {
  runComposition();
}, 130_000);

for (const failure of ["missing host", "inconsistent host", "dependency lookup", "config write"] as const) {
  test(`owned child sandbox is removed after setup failure: ${failure}`, () => {
    withOwnedSandbox((fixture) => {
      const host = join(fixture, "host");
      if (failure !== "missing host") {
        for (const [index, peer] of peers.entries()) {
          mkdirSync(join(host, peer), { recursive: true });
          writeFileSync(
            join(host, peer, "package.json"),
            JSON.stringify({
              version: failure === "inconsistent host" && index === 0 ? "1.0.4" : "1.4.0",
            }),
          );
        }
      }
      let ownedSandbox: string | undefined;
      assert.throws(
        () =>
          runComposition({
            host,
            dependenciesRoot: failure === "dependency lookup" ? fixture : undefined,
            onSandbox: (sandbox) => {
              ownedSandbox = sandbox;
              assert.ok(existsSync(sandbox));
            },
            writeConfig:
              failure === "config write"
                ? () => {
                    throw new Error("controlled config write failure");
                  }
                : undefined,
          }),
        failure === "missing host"
          ? /ENOENT/
          : failure === "inconsistent host"
            ? /four consistent host peers/
            : failure === "dependency lookup"
              ? /existing dependencies required/
              : /controlled config write failure/,
      );
      assert.ok(ownedSandbox, "failure must happen after ownership begins");
      assert.equal(existsSync(ownedSandbox), false, "all post-creation setup failures clean up the owned directory");
    });
  });
}
